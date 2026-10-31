/**
 * Sheet-metal references (docs/SHEET_METAL.md). A panel `P` has faces `P.top`, `P.bottom`,
 * `P.side(name)` and, for a flange, `P.bend.inner|outer|start|end`. Flanges, hems and jogs attach to
 * a free edge of a panel's top face, `edge(P.side(name)|P.top)`: one name for the whole thickness
 * edge, so picking its top edge, bottom edge or side face all mean the same rim.
 */

/** The panel a face reference belongs to (`flange_1.bend.inner` → `flange_1`), or null. */
export function panelOf(ref: string): string | null {
  return /^([^()|]+?)\.(?:top|bottom|side\(.+\)|bend\.(?:inner|outer|start|end))$/.exec(ref)?.[1] ?? null;
}

/** The bend a bend face belongs to (`wall.bend.inner` → `wall`, `contour.2.bend.outer` → `contour.2`), or null. */
export function bendOf(ref: string): string | null {
  return /^(.+?)\.bend\.(?:inner|outer|start|end)$/.exec(ref)?.[1] ?? null;
}

function splitTop(text: string): string[] {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === '|' && depth === 0) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text];
}

const SIDE = /^([^()|]+?)\.side\((.+)\)$/;

/** The rim (`edge(P.side(s)|P.top)`) a picked edge or side face stands for, or null when it isn't one. */
export function rimOf(ref: string): string | null {
  const face = SIDE.exec(ref);
  if (face) return `edge(${ref}|${face[1]}.top)`;
  const edge = /^edge\((.+)\)$/.exec(ref);
  if (!edge) return null;
  const faces = splitTop(edge[1]);
  if (faces.length !== 2) return null;
  const side = faces.map((name) => SIDE.exec(name)).find(Boolean);
  if (!side) return null;
  const other = faces.find((name) => !SIDE.test(name));
  if (other !== `${side[1]}.top` && other !== `${side[1]}.bottom`) return null;
  return `edge(${side[0]}|${side[1]}.top)`;
}
