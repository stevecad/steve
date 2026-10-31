import type { SourceDiagnostic } from './diagnostics';

const FRAME = /^\s*File "(.+)", line (\d+)(?:, in .*)?$/;
const CARETS = /^(\s*)([~^]+)\s*$/;
/** CPython prints the offending source line of a frame indented by four spaces. */
const CODE_INDENT = 4;

/**
 * Turn a CPython traceback into a diagnostic on the last frame that belongs
 * to `filename`, carrying the final exception line(s) as the message.
 *
 * Pass the executed `source` to get an exact column range from the caret
 * markers: tracebacks print lines with their indentation stripped, so the
 * source is needed to map carets back to real columns.
 */
export function diagnosticsFromTraceback(error: string, filename = '/work/model.py', source?: string): SourceDiagnostic[] {
  const lines = error.replace(/\r\n?/g, '\n').split('\n');
  let frame = -1;
  let lastFrame = -1;
  let lineNumber = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = FRAME.exec(lines[i]);
    if (!m) continue;
    lastFrame = i;
    if (m[1] === filename) {
      frame = i;
      lineNumber = Number(m[2]);
    }
  }
  if (frame < 0 || lineNumber < 1) return [];

  // The exception text follows the last frame's indented code/caret lines.
  let start = lastFrame + 1;
  while (start < lines.length && /^\s/.test(lines[start])) start++;
  const message = lines.slice(start).join('\n').trim()
    || lines.filter((l) => l.trim()).pop()?.trim()
    || 'Error';

  const diagnostic: SourceDiagnostic = { line: lineNumber, message, severity: 'error' };
  const code = lines[frame + 1];
  const carets = CARETS.exec(lines[frame + 2] ?? '');
  if (source !== undefined && code !== undefined && /^\s/.test(code) && carets) {
    const actual = source.replace(/\r\n?/g, '\n').split('\n')[lineNumber - 1];
    if (actual !== undefined && actual.trim() === code.trim()) {
      const indent = actual.length - actual.trimStart().length;
      const offset = carets[1].length - CODE_INDENT;
      if (offset >= 0) {
        diagnostic.column = indent + offset + 1;
        diagnostic.endColumn = diagnostic.column + carets[2].length;
      }
    }
  }
  return [diagnostic];
}
