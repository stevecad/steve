/** Arithmetic expressions: parameter values and number fields. */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI, abs: Math.abs, min: Math.min, max: Math.max,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, hypot: Math.hypot,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

/**
 * Evaluates arithmetic over named values (a document's parameters, lib/modeling.ts; none for a plain number field):
 * numbers, names, + - * / // % **, parentheses and math functions, the subset the server accepts. Null when it isn't
 * that. A parser, never eval: the app runs under a CSP without 'unsafe-eval'.
 */
export function arithmetic(expression: string, named: Record<string, number> = {}): number | null {
  const values: Record<string, number> = { ...CONSTANTS, ...named };
  const tokens = expression.match(/\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\*\*|\/\/|[-+*/%(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const fail = (): never => { throw new Error('bad expression'); };
  const atom = (): number => {
    const token = take();
    if (token === undefined) return fail();
    if (/^[\d.]/.test(token)) return Number(token);
    if (token === '(') { const value = sum(); if (take() !== ')') fail(); return value; }
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === '(') {
        const fn = Object.hasOwn(FUNCTIONS, token) ? FUNCTIONS[token] : fail();
        take();
        const args: number[] = [];
        if (peek() !== ')') { do { args.push(sum()); } while (peek() === ',' && take()); }
        if (take() !== ')') fail();
        return fn(...args);
      }
      return Object.hasOwn(values, token) ? values[token] : fail();
    }
    return fail();
  };
  const unary = (): number => (peek() === '-' ? (take(), -unary()) : peek() === '+' ? (take(), unary()) : power());
  const power = (): number => { const base = atom(); return peek() === '**' ? (take(), base ** unary()) : base; };
  const product = (): number => {
    let value = unary();
    for (let op = peek(); op === '*' || op === '/' || op === '//' || op === '%'; op = peek()) {
      take();
      const right = unary();
      value = op === '*' ? value * right : op === '/' ? value / right : op === '//' ? Math.floor(value / right) : ((value % right) + right) % right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    for (let op = peek(); op === '+' || op === '-'; op = peek()) { take(); value = op === '+' ? value + product() : value - product(); }
    return value;
  };
  try {
    const value = sum();
    return i === tokens.length && Number.isFinite(value) ? value : null;
  } catch { return null; }
}
