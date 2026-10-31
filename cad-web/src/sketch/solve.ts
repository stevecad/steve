/**
 * Sketch solving in the browser, through the shared planegcs core (web/src/sketch/solver,
 * built from solver/). Until that module is present, sketches keep their declared
 * geometry and report "unsolved", exactly like the runtime does without the solver.
 */
import type { Entity, SolverDoc } from './model';

export interface SolveResult {
  status: 'ok' | 'failed' | 'unsolved';
  dof: number | null;
  conflicting: string[];
  redundant: string[];
  partially_redundant: string[];
  entities: Entity[];
  free: Record<string, boolean>;
  values: Record<string, number>;
}

interface SolverModule {
  loadSolver: () => Promise<unknown>;
  solve: (doc: SolverDoc, options?: Record<string, unknown>) => Promise<SolveResult> | SolveResult;
}

// Resolved at build time: an empty object when the solver hasn't been built into the app yet.
const modules = import.meta.glob<SolverModule>('./solver/index.ts');
let loading: Promise<SolverModule | null> | null = null;

function solver(): Promise<SolverModule | null> {
  loading ??= (async () => {
    const load = modules['./solver/index.ts'];
    if (!load) return null;
    try {
      const mod = await load();
      await mod.loadSolver();
      return mod;
    } catch (error) {
      console.warn('Sketch solver unavailable:', error);
      return null;
    }
  })();
  return loading;
}

export const solverAvailable = async () => !!(await solver());

/** Solves from the declared geometry (the last solved state), like the runtime does on rebuild. */
export async function solveSketch(doc: SolverDoc): Promise<SolveResult> {
  const unsolved: SolveResult = { status: 'unsolved', dof: null, conflicting: [], redundant: [], partially_redundant: [], entities: doc.entities, free: {}, values: {} };
  const solvable = { entities: doc.entities.filter((e) => e.type !== 'projection'), constraints: doc.constraints };
  if (!solvable.constraints.length) return { ...unsolved, status: 'ok', dof: null };
  const mod = await solver();
  if (!mod) return unsolved;
  try {
    const result = await mod.solve(solvable);
    // Keep projection placeholders (their geometry comes from the model) in the entity list.
    const solved = new Map(result.entities.map((e) => [e.id, e]));
    return { ...result, entities: doc.entities.map((e) => solved.get(e.id) ?? e) };
  } catch (error) {
    return { ...unsolved, status: 'failed', conflicting: [], entities: doc.entities, free: {}, values: {}, dof: null, redundant: [], partially_redundant: [] };
  }
}
