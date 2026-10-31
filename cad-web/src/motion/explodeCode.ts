/**
 * `design.explode(...)` as Python, the way the Explode steps tool writes it (motion/code.ts puts it into main.py).
 * Plain functions with no app state, so tests run them outside a browser.
 */

/** Retain the entered distance and timing; formatting must not change the model. */
const pyNumber = (value: number) => String(value);

export type Vec = [number, number, number];

/** One step as the Explode steps tool writes it: its parts and their moves (one shared move, or each its own), or placed screws out along their axes. */
export interface ExplodeStepSpec {
  name?: string;
  /** Each part's move (mm, design frame). */
  moves: Record<string, Vec>;
  /** Placed screws out along their own axes: true (1.5 × their length) or a distance in mm. */
  out?: true | number;
  duration?: number;
  hold?: number;
}

export interface ExplodeSpec {
  name: string;
  auto?: boolean;
  steps: ExplodeStepSpec[];
  loop?: boolean;
  easing?: 'linear' | 'ease';
  duration?: number;
  hold?: number;
  gap?: number | null;
  /** A rename/options edit leaves the original step expressions untouched. */
  preserveSteps?: boolean;
}

export const EXPLODE_DURATION = 1;
export const EXPLODE_HOLD = 0.25;

const vec = (v: Vec) => `(${v.map(pyNumber).join(', ')})`;
const same = (a: Vec, b: Vec) => a.every((value, k) => Math.abs(value - b[k]) < 1e-9);

/** One step as Python: the short form for one part, a shared move, out for screws, or each part its own move. */
export function explodeStepSource(step: ExplodeStepSpec): string {
  const parts = Object.keys(step.moves);
  const extras = [step.duration !== undefined && step.duration !== null ? `"duration": ${pyNumber(step.duration)}` : '',
    step.hold !== undefined && step.hold !== null ? `"hold": ${pyNumber(step.hold)}` : '', step.name ? `"name": ${JSON.stringify(step.name)}` : ''].filter(Boolean);
  const move = parts.length === 1 ? JSON.stringify(parts[0]) : `[${parts.map((part) => JSON.stringify(part)).join(', ')}]`;
  if (step.out !== undefined) return `{"move": ${move}, "out": ${step.out === true ? 'True' : pyNumber(step.out)}${extras.map((e) => `, ${e}`).join('')}}`;
  const vectors = Object.values(step.moves);
  if (vectors.every((v) => same(v, vectors[0]))) {
    if (!extras.length && parts.length === 1) return `(${move}, ${vec(vectors[0])})`;
    return `{"move": ${move}, "by": ${vec(vectors[0])}${extras.map((e) => `, ${e}`).join('')}}`;
  }
  return `{"moves": {${Object.entries(step.moves).map(([part, v]) => `${JSON.stringify(part)}: ${vec(v)}`).join(', ')}}${extras.map((e) => `, ${e}`).join('')}}`;
}

export function explodeSource(spec: ExplodeSpec, stepsSource?: string): string {
  const options = [spec.loop ? 'loop=True' : '', spec.easing && spec.easing !== 'ease' ? `easing=${JSON.stringify(spec.easing)}` : '',
    spec.duration !== undefined && spec.duration !== EXPLODE_DURATION ? `duration=${pyNumber(spec.duration)}` : '',
    spec.hold !== undefined && spec.hold !== EXPLODE_HOLD ? `hold=${pyNumber(spec.hold)}` : '', spec.auto && spec.gap ? `gap=${pyNumber(spec.gap)}` : ''].filter(Boolean);
  const tail = `${options.length ? `, ${options.join(', ')}` : ''})`;
  if (spec.auto) return `design.explode(${JSON.stringify(spec.name)}, auto=True${tail}`;
  if (stepsSource) return `design.explode(${JSON.stringify(spec.name)}, ${stepsSource}${tail}`;
  return `design.explode(${JSON.stringify(spec.name)}, [\n${spec.steps.map((step) => `    ${explodeStepSource(step)},`).join('\n')}\n]${tail}`;
}

