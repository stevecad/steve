/**
 * Saved section views in the code: `section_view("bore_cut", axis="x", at=12.5)` (runtime/steve/sections.py), one call
 * a line with literal values, as the Section analysis tool writes them. These read and write that one form, like
 * construction planes (lib/construction.ts); a call written another way still builds, it just isn't listed.
 */
export type SectionAxis = 'x' | 'y' | 'z';
export interface SectionView { name: string; axis: SectionAxis; at: number; flip: boolean; line: number }

const NAME = /^[a-z][a-z0-9_]*$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const CALL = /^(?:steve\.)?section_view\((.*)\)\s*(?:#.*)?$/;
const IMPORT = /^(import|from)\s/;

const unquote = (text: string | undefined) => (text && /^(["'])[^"']*\1$/.test(text) ? text.slice(1, -1) : null);

export function parseSectionViews(code: string): SectionView[] {
  const out: SectionView[] = [];
  code.split('\n').forEach((text, index) => {
    const match = CALL.exec(text.trimEnd());
    if (!match) return;
    const keyword: Record<string, string> = {};
    const positional: string[] = [];
    for (const arg of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
      const pair = /^(\w+)\s*=\s*(.+)$/.exec(arg);
      if (pair) keyword[pair[1]] = pair[2].trim(); else positional.push(arg);
    }
    const name = unquote(keyword.name ?? positional[0]);
    const axisText = keyword.axis ?? positional[1];
    const axis = axisText === undefined ? 'z' : unquote(axisText)?.toLowerCase();
    const at = keyword.at ?? positional[2] ?? '0';
    const flip = keyword.flip ?? positional[3] ?? 'False';
    if (!name || !NAME.test(name) || (axis !== 'x' && axis !== 'y' && axis !== 'z') || !NUMBER.test(at) || (flip !== 'True' && flip !== 'False')) return;
    out.push({ name, axis, at: Number(at), flip: flip === 'True', line: index + 1 });
  });
  return out;
}

/** Millimetres as people write them: 12.5, -3, 0.333333. */
export const sectionMm = (value: number) => Number(Number(value).toPrecision(6));

export function sectionSource(view: Omit<SectionView, 'line'>): string {
  return `section_view(${JSON.stringify(view.name)}, axis=${JSON.stringify(view.axis)}, at=${sectionMm(view.at)}${view.flip ? ', flip=True' : ''})`;
}

const afterImports = (lines: string[]) => lines.reduce((at, text, index) => (IMPORT.test(text) ? index + 1 : at), 0);

/** `section_view` imported from steve: added to a one-line `from steve import …`, else its own import line. */
function withImport(code: string): string {
  if (/^from steve import .*\bsection_view\b/m.test(code)) return code;
  const lines = code.split('\n');
  const steve = lines.findIndex((line) => /^from steve import [^()#]+$/.test(line.trimEnd()));
  if (steve >= 0) lines[steve] = `${lines[steve].trimEnd()}, section_view`;
  else lines.splice(afterImports(lines), 0, 'from steve import section_view');
  return lines.join('\n');
}

/** Adds a section view after the imports (after the others), or rewrites the line of `replacing` (or of its own name). */
export function insertSectionView(code: string, view: Omit<SectionView, 'line'>, replacing?: string | null): string {
  const source = sectionSource(view);
  const old = parseSectionViews(code).find((item) => item.name === (replacing || view.name));
  if (old) {
    const lines = code.split('\n');
    lines[old.line - 1] = source;
    return lines.join('\n');
  }
  const lines = withImport(code).split('\n');
  const views = parseSectionViews(lines.join('\n'));
  const at = afterImports(lines);
  if (views.length) lines.splice(Math.max(at, views[views.length - 1].line), 0, source);
  // The first one: its own paragraph after the imports.
  else lines.splice(at, 0, ...(at > 0 && lines[at - 1].trim() ? [''] : []), source, ...(lines[at]?.trim() ? [''] : []));
  return lines.join('\n');
}

export function removeSectionViewLine(code: string, name: string): string {
  const found = parseSectionViews(code).find((item) => item.name === name);
  if (!found) return code;
  const lines = code.split('\n');
  lines.splice(found.line - 1, 1);
  return lines.join('\n');
}

/** Names not used by a section view yet: section_1, section_2, … */
export function nextSectionName(views: SectionView[]): string {
  for (let n = 1; ; n++) if (!views.some((view) => view.name === `section_${n}`)) return `section_${n}`;
}

/** Why a name can't be saved (null when it can); `editing` is the view being rewritten, which may keep its name. */
export function sectionNameProblem(name: string, editing: string | null, views: SectionView[]): string | null {
  if (!NAME.test(name)) return 'Names are lowercase letters, digits and underscores, starting with a letter.';
  if (name !== editing && views.some((view) => view.name === name)) return `There is already a section view named ${name}.`;
  return null;
}
