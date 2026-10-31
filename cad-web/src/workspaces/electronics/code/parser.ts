/**
 * `@babel/parser`, loaded on first use so it stays out of the main bundle. `ensureParser()` once (the Electronics
 * workspace does it when it opens); after that every parse and edit is synchronous.
 */

type BabelParse = (code: string, options: Record<string, unknown>) => BabelFile;

/** The slice of Babel's AST the index reads. */
export interface BabelNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
export interface BabelFile extends BabelNode {
  program: BabelNode & { body: BabelNode[] };
  errors?: { message: string; loc?: { line: number; column: number }; pos?: number }[];
}

let parseFn: BabelParse | null = null;
let loading: Promise<void> | null = null;

/** Loads the parser (once). */
export function ensureParser(): Promise<void> {
  if (parseFn) return Promise.resolve();
  loading ??= import('@babel/parser').then((module) => {
    const babel = module as unknown as { parse?: BabelParse; default?: { parse: BabelParse } };
    parseFn = babel.parse ?? babel.default!.parse;
  });
  return loading;
}

export const parserReady = () => parseFn !== null;

export const BABEL_OPTIONS = {
  sourceType: 'module',
  plugins: ['jsx', 'typescript'],
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
};

/** Parses TSX. Throws when `ensureParser()` hasn't finished; throws Babel's error for code it can't recover from. */
export function babelParse(code: string): BabelFile {
  if (!parseFn) throw new Error('The TSX parser is still loading: await ensureParser() first.');
  return parseFn(code, BABEL_OPTIONS);
}

/** Babel's own expression parser, for a value typed into a form (`{{ x: 1 }}` without the braces). */
export function babelParseExpression(code: string): BabelNode {
  const file = babelParse(`(${code});`);
  const statement = file.program.body[0] as BabelNode & { expression?: BabelNode };
  if (file.errors?.length || !statement || statement.type !== 'ExpressionStatement' || !statement.expression) {
    throw new Error(file.errors?.[0]?.message ?? 'Not a value.');
  }
  return statement.expression;
}
