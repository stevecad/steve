/**
 * STEVE sketch solver (FreeCAD planegcs compiled to WebAssembly).
 *
 * Framework-free: works on the main thread, in a (module) Web Worker and in Node >= 22 (tests).
 * The JSON contract is docs/MODELING.md section 2 "Solver JSON"; lengths in mm, angles in radians.
 * The server runs the identical C++ core as the Python module `steve_sketch` (parity-tested).
 *
 *   const solver = await loadSolver();               // once (cached)
 *   const result = solver.solve(sketch);            // one-shot; or the module-level solve(sketch)
 *   const session = solver.createSession(sketch);   // interactive (dispose() when done)
 *   session.drag('l1.end', x, y);                   // per pointer move
 *   session.endDrag();
 *   session.setValue('d1', 42); session.solve();
 *
 * Built by solver/build-wasm.sh; licensing: solver/README.md (LGPL-2.1 planegcs, separate module).
 */
import createSteveSketch from './steve-sketch.mjs';
import type { SteveSketchModule, SteveSketchModuleOptions } from './steve-sketch.mjs';

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

export type Vec2 = [number, number];

interface EntityBase {
  id: string;
  /** Construction geometry never forms profiles (no solver meaning). */
  construction?: boolean;
  /** External (projected / reference) geometry: fixed, echoed unchanged. */
  external?: boolean;
  /** Extra fields are preserved and echoed back by the solver. */
  [extra: string]: unknown;
}

export interface PointEntity extends EntityBase {
  type: 'point';
  at: Vec2;
}
export interface LineEntity extends EntityBase {
  type: 'line';
  start: Vec2;
  end: Vec2;
}
export interface CircleEntity extends EntityBase {
  type: 'circle';
  center: Vec2;
  radius: number;
}
/** Counter-clockwise from start_angle to end_angle (radians). Solved arcs come back with
 * start_angle in (-pi, pi] and end_angle in (start_angle, start_angle + 2pi]. */
export interface ArcEntity extends EntityBase {
  type: 'arc';
  center: Vec2;
  radius: number;
  start_angle: number;
  end_angle: number;
}
/** major_radius > minor_radius > 0; rotation = direction of the major axis (radians). */
export interface EllipseEntity extends EntityBase {
  type: 'ellipse';
  center: Vec2;
  major_radius: number;
  minor_radius: number;
  rotation?: number;
}
/** Angles are parametric (eccentric) angles measured from the major axis, counter-clockwise. */
export interface EllipticalArcEntity extends EntityBase {
  type: 'elliptical_arc';
  center: Vec2;
  major_radius: number;
  minor_radius: number;
  rotation?: number;
  start_angle: number;
  end_angle: number;
}
/** Non-rational unless `weights` is given; default knots are uniform (clamped unless periodic).
 * Points: `<id>.pole<i>`, and `<id>.start` / `<id>.end` for clamped splines. */
export interface BSplineEntity extends EntityBase {
  type: 'bspline';
  poles: Vec2[];
  degree?: number;
  periodic?: boolean;
  weights?: number[];
  knots?: number[];
  multiplicities?: number[];
}

export type SketchEntity =
  | PointEntity
  | LineEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | EllipticalArcEntity
  | BSplineEntity;

export type GeometricConstraintType =
  | 'coincident'
  | 'point_on'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'collinear'
  | 'tangent'
  | 'equal'
  | 'symmetric'
  | 'midpoint'
  | 'concentric'
  | 'fix';

export type DimensionalConstraintType =
  | 'distance'
  | 'length'
  | 'horizontal_distance'
  | 'vertical_distance'
  | 'angle'
  | 'radius'
  | 'diameter';

export type ConstraintType = GeometricConstraintType | DimensionalConstraintType;

/**
 * Refs are entity ids, point refs (`<entity>.start|end|center`, `<bspline>.pole<i>`, point entity
 * ids) or the fixed built-ins `origin`, `x_axis`, `y_axis`.
 */
export interface SketchConstraint {
  /** Unique id; defaults to `k<n>` (1-based position) when omitted. */
  id?: string;
  type: ConstraintType;
  refs: string[];
  /** Dimension value (mm / radians), or [x, y] for `fix` on a point. */
  value?: number | Vec2;
  /** false = reference dimension: measured, never enforced. Dimensional constraints only. */
  driving?: boolean;
  /** tangent only: the point where the curves touch (endpoint tangency via angle_via_point). */
  at?: string;
}

export interface Sketch {
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
}

export interface SolveOptions {
  /** Iteration limit per algorithm (default 100). */
  max_iterations?: number;
  /** Convergence threshold (default 1e-10). */
  convergence?: number;
  /** DogLeg, then Levenberg-Marquardt, then BFGS (default true); false = DogLeg only. */
  fallback?: boolean;
  /** QR used by the diagnosis (default "sparse"). */
  qr?: 'sparse' | 'dense';
  /** SQP step size (mm) that ends a drag frame (default 1e-5). */
  drag_convergence?: number;
}

export interface SolveResult {
  /** "failed" when the solve did not converge or constraints conflict (geometry unchanged). */
  status: 'ok' | 'failed';
  /** Remaining degrees of freedom (negative when over-constrained). */
  dof: number;
  conflicting: string[];
  redundant: string[];
  partially_redundant: string[];
  /** Solved entities, same schema (and extra fields) as the input. */
  entities: SketchEntity[];
  /** true if any parameter of the entity is still free (not fully constrained). */
  free: Record<string, boolean>;
  /** Measured value of every dimensional constraint (driving and reference), mm / radians. */
  values: Record<string, number>;
  /** Most robust algorithm that was needed, null when failed or nothing to solve. */
  algorithm: 'dogleg' | 'lm' | 'bfgs' | null;
  /** Reason when status is "failed". */
  message?: string;
}

export interface DragResult {
  /** "failed" leaves the geometry at the previous frame. */
  status: 'ok' | 'failed';
  entities: SketchEntity[];
  message?: string;
}

export interface MemoryStats {
  /** Size of the WebAssembly linear memory. */
  heap_bytes: number;
  /** Bytes currently allocated by malloc. */
  in_use_bytes: number;
  /** Live sessions in this module instance. */
  sessions: number;
}

/** The sketch or a call violates the Solver JSON contract (bad ref, unknown type, ...). */
export class SolverInputError extends Error {
  override name = 'SolverInputError';
}

/** Internal solver failure (out of memory, disposed module, ...). */
export class SolverError extends Error {
  override name = 'SolverError';
}

// ---------------------------------------------------------------------------------------------
// Module instance
// ---------------------------------------------------------------------------------------------

export interface LoadSolverOptions {
  /** Where to fetch steve-sketch.wasm from (default: next to steve-sketch.mjs). */
  wasmUrl?: string | URL;
  /** Pre-fetched module bytes (skips fetching). */
  wasmBinary?: ArrayBuffer | Uint8Array;
}

function callString<T>(m: SteveSketchModule, strings: string[], fn: (...ptrs: number[]) => T): T {
  const ptrs: number[] = [];
  try {
    for (const s of strings) {
      const size = m.lengthBytesUTF8(s) + 1;
      const ptr = m._malloc(size);
      if (!ptr) throw new SolverError('out of memory');
      m.stringToUTF8(s, ptr, size);
      ptrs.push(ptr);
    }
    return fn(...ptrs);
  } finally {
    for (const p of ptrs) m._free(p);
  }
}

function lastError(m: SteveSketchModule): Error {
  const message = m.UTF8ToString(m._steve_last_error());
  return m._steve_last_error_kind() === 1 ? new SolverInputError(message) : new SolverError(message);
}

function readJson<T>(m: SteveSketchModule, ptr: number): T {
  if (!ptr) throw lastError(m);
  return JSON.parse(m.UTF8ToString(ptr)) as T;
}

function encodeSketch(sketch: Sketch | string): string {
  return typeof sketch === 'string' ? sketch : JSON.stringify(sketch);
}

function encodeOptions(options: SolveOptions | undefined): string {
  return options ? JSON.stringify(options) : '{}';
}

// Frees native sessions that were garbage-collected without dispose().
const sessionFinalizer =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<{ m: SteveSketchModule; handle: number }>(({ m, handle }) => {
        m._steve_session_free(handle);
      })
    : undefined;

export class SketchSolver {
  readonly version: string;
  readonly #m: SteveSketchModule;

  constructor(module: SteveSketchModule) {
    this.#m = module;
    this.version = module.UTF8ToString(module._steve_version());
  }

  /** Solves a sketch (object or JSON string). Throws SolverInputError for contract violations. */
  solve(sketch: Sketch | string, options?: SolveOptions): SolveResult {
    const m = this.#m;
    return callString(m, [encodeSketch(sketch), encodeOptions(options)], (s, o) =>
      readJson<SolveResult>(m, m._steve_solve(s, o)),
    );
  }

  /** Builds, diagnoses and solves the sketch for interactive editing. Call dispose() when done. */
  createSession(sketch: Sketch | string, options?: SolveOptions): Session {
    const m = this.#m;
    const handle = callString(m, [encodeSketch(sketch), encodeOptions(options)], (s, o) =>
      m._steve_session_new(s, o),
    );
    if (!handle) throw lastError(m);
    return new Session(m, handle);
  }

  memoryStats(): MemoryStats {
    return readJson<MemoryStats>(this.#m, this.#m._steve_memory_stats());
  }
}

/**
 * An interactive solver session: the GCS system is built once; drag() moves temporary soft
 * constraints (updated in place, FreeCAD-style) and each frame starts from the previous one.
 */
export class Session {
  readonly #m: SteveSketchModule;
  #handle: number;
  readonly #token = {};

  /** @internal use SketchSolver.createSession() */
  constructor(module: SteveSketchModule, handle: number) {
    this.#m = module;
    this.#handle = handle;
    sessionFinalizer?.register(this, { m: module, handle }, this.#token);
  }

  #live(): number {
    if (!this.#handle) throw new SolverError('session is disposed');
    return this.#handle;
  }

  /**
   * Drags `ref` to (x, y): point refs follow the cursor; circle/arc ids pull the rim through it;
   * line, ellipse, elliptical_arc and bspline ids translate with the cursor motion since the
   * first drag() of the gesture. A different ref starts a new gesture.
   */
  drag(ref: string, x: number, y: number): DragResult {
    const m = this.#m;
    const h = this.#live();
    return callString(m, [ref], (r) => readJson<DragResult>(m, m._steve_session_drag(h, r, x, y)));
  }

  /** Ends the drag gesture; returns the full result for the current geometry. */
  endDrag(): SolveResult {
    return readJson<SolveResult>(this.#m, this.#m._steve_session_end_drag(this.#live()));
  }

  /** Changes a driving dimension in place; applied by the next solve(). */
  setValue(constraintId: string, value: number): void {
    const m = this.#m;
    const h = this.#live();
    const ok = callString(m, [constraintId], (id) => m._steve_session_set_value(h, id, value));
    if (!ok) throw lastError(m);
  }

  /** Ends any drag and solves from the current geometry. */
  solve(): SolveResult {
    return readJson<SolveResult>(this.#m, this.#m._steve_session_solve(this.#live()));
  }

  /** Re-runs the DOF / conflict / redundancy diagnosis at the current geometry. */
  diagnose(): SolveResult {
    return readJson<SolveResult>(this.#m, this.#m._steve_session_diagnose(this.#live()));
  }

  /** Full result for the current state without solving. */
  snapshot(): SolveResult {
    return readJson<SolveResult>(this.#m, this.#m._steve_session_snapshot(this.#live()));
  }

  get disposed(): boolean {
    return this.#handle === 0;
  }

  dispose(): void {
    if (this.#handle) {
      sessionFinalizer?.unregister(this.#token);
      this.#m._steve_session_free(this.#handle);
      this.#handle = 0;
    }
  }
}

let defaultSolver: Promise<SketchSolver> | undefined;
let current: SketchSolver | undefined;

/**
 * Instantiates the WebAssembly module. Without options the instance is shared (cached); pass
 * `wasmUrl` / `wasmBinary` to control loading (e.g. from a CDN or a pre-fetched response).
 * The most recently loaded instance also backs the module-level solve() / createSession().
 */
export function loadSolver(options?: LoadSolverOptions): Promise<SketchSolver> {
  if (!options?.wasmUrl && !options?.wasmBinary) {
    defaultSolver ??= instantiate({}).catch((error: unknown) => {
      defaultSolver = undefined;
      throw error;
    });
    return defaultSolver;
  }
  const moduleOptions: SteveSketchModuleOptions = {};
  if (options.wasmBinary) moduleOptions.wasmBinary = options.wasmBinary;
  if (options.wasmUrl) {
    const url = String(options.wasmUrl);
    moduleOptions.locateFile = () => url;
  }
  return instantiate(moduleOptions);
}

async function instantiate(moduleOptions: SteveSketchModuleOptions): Promise<SketchSolver> {
  const solver = new SketchSolver(await createSteveSketch(moduleOptions));
  current = solver;
  return solver;
}

function loaded(): SketchSolver {
  if (!current) throw new SolverError('the solver is not loaded yet: await loadSolver() first');
  return current;
}

/** One-shot solve with the loaded instance (synchronous; await loadSolver() once before). */
export function solve(sketch: Sketch | string, options?: SolveOptions): SolveResult {
  return loaded().solve(sketch, options);
}

/** Interactive session on the loaded instance (see Session; dispose() when done). */
export function createSession(sketch: Sketch | string, options?: SolveOptions): Session {
  return loaded().createSession(sketch, options);
}
