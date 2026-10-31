/**
 * Number literals in text, for scrubbing (the code editor's Alt+drag and press-and-drag on number fields). No editor
 * imports, so the shared form controls can use it without loading CodeMirror.
 */

/** A number literal in `text` that covers `column` (not part of a name like extrude_1, not an exponent tail). */
export function numberAt(text: string, column: number): { from: number; to: number; value: string } | null {
  const re = /-?\d+(?:\.\d+)?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index, to = m.index + m[0].length;
    if (column < from || column > to) continue;
    const before = text[from - 1] ?? '';
    if (/[A-Za-z_.]/.test(before) || /[A-Za-z_]/.test(text[to] ?? '')) return null;
    return { from, to, value: m[0] };
  }
  return null;
}

export const decimals = (value: string) => (value.includes('.') ? value.split('.')[1].length : 0);

export function format(value: number, places: number): string {
  const text = value.toFixed(places);
  return text === '-0' || /^-0\.0+$/.test(text) ? text.slice(1) : text;
}
