import * as THREE from 'three';
import { pythonLanguage } from '@codemirror/lang-python';

/**
 * Construction planes live in the CadQuery source as named `cq.Plane` definitions, so they
 * are part of the design (and usable as `cq.Workplane(plane_1)`) rather than view-only state.
 * The UI writes and reads one canonical line format.
 */
export interface ConstructionPlane {
  name: string;
  origin: THREE.Vector3;
  xDir: THREE.Vector3;
  normal: THREE.Vector3;
  comment: string;
  line: number;
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;
const TRIPLE = String.raw`\(\s*(${NUMBER})\s*,\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\)`;
const PLANE_LINE = new RegExp(String.raw`^([A-Za-z_]\w*)\s*=\s*cq\.Plane\(\s*origin\s*=\s*${TRIPLE}\s*,\s*xDir\s*=\s*${TRIPLE}\s*,\s*normal\s*=\s*${TRIPLE}\s*\)\s*(?:#\s*(.*))?$`);

export function parsePlanes(code: string): ConstructionPlane[] {
  const planes: ConstructionPlane[] = [];
  const tree = pythonLanguage.parser.parse(code);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'AssignStatement') continue;
    const text = code.slice(node.from, code.indexOf('\n', node.to) < 0 ? code.length : code.indexOf('\n', node.to));
    if (text.includes('\n')) continue; // Only the canonical one-line format is editable here.
    const match = PLANE_LINE.exec(text.trim());
    if (!match) continue;
    const n = match.slice(2, 11).map(Number);
    planes.push({
      name: match[1],
      origin: new THREE.Vector3(n[0], n[1], n[2]),
      xDir: new THREE.Vector3(n[3], n[4], n[5]).normalize(),
      normal: new THREE.Vector3(n[6], n[7], n[8]).normalize(),
      comment: (match[11] ?? '').trim(),
      line: code.slice(0, node.from).split('\n').length,
    });
  }
  return planes;
}

const clean = (value: number) => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const triple = (v: THREE.Vector3) => `(${clean(v.x)}, ${clean(v.y)}, ${clean(v.z)})`;

/** A stable in-plane X direction: world X unless the plane faces X, then world Y. */
export function defaultXDir(normal: THREE.Vector3): THREE.Vector3 {
  const n = normal.clone().normalize();
  const reference = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return reference.sub(n.clone().multiplyScalar(reference.dot(n))).normalize();
}

export function planeLine(name: string, origin: THREE.Vector3, normal: THREE.Vector3, comment: string, xDir = defaultXDir(normal)) {
  return `${name} = cq.Plane(origin=${triple(origin)}, xDir=${triple(xDir)}, normal=${triple(normal.clone().normalize())})  # ${comment}`;
}

export function nextPlaneName(code: string): string {
  const used = new Set(Array.from(code.matchAll(/\bplane_(\d+)\b/g), (match) => Number(match[1])));
  let index = 1;
  while (used.has(index)) index++;
  return `plane_${index}`;
}

/** Inserts a definition after the import block so later code (and STEVE) can use it. */
export function insertPlane(code: string, line: string): string {
  const lines = code.split('\n');
  let at = 0;
  while (at < lines.length && /^\s*(?:#.*)?$/.test(lines[at])) at++;
  let firstStatement = true;
  let needsImport = true;
  const tree = pythonLanguage.parser.parse(code);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'Comment') continue;
    const text = code.slice(node.from, node.to);
    if (node.name === 'ImportStatement') {
      at = Math.max(at, code.slice(0, node.to).split('\n').length);
      if (/^import\s+cadquery\s+as\s+cq\b/.test(text)) needsImport = false;
    } else if (firstStatement && node.name === 'ExpressionStatement' && node.firstChild?.name === 'String') {
      at = Math.max(at, code.slice(0, node.to).split('\n').length);
    }
    firstStatement = false;
  }
  const planes = parsePlanes(code);
  if (planes.length) at = Math.max(at, planes[planes.length - 1].line);
  const block = [...(at > 0 && lines[at - 1]?.trim() && !planes.length ? [''] : []), ...(needsImport ? ['import cadquery as cq'] : []), line];
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

export function removePlane(code: string, plane: ConstructionPlane): string {
  const lines = code.split('\n');
  if (PLANE_LINE.test(lines[plane.line - 1]?.trim() ?? '')) lines.splice(plane.line - 1, 1);
  return lines.join('\n');
}

export function isReferenced(code: string, name: string): boolean {
  const declarations = new Set(parsePlanes(code).filter((plane) => plane.name === name).map((plane) => plane.line));
  let found = false;
  pythonLanguage.parser.parse(code).iterate({ enter(node) {
    if (node.name === 'VariableName' && code.slice(node.from, node.to) === name && !declarations.has(code.slice(0, node.from).split('\n').length)) found = true;
  } });
  return found;
}

/** A point halfway along the signed separation of two parallel planes. */
export function parallelMidplane(a: THREE.Vector3, normalA: THREE.Vector3, b: THREE.Vector3, normalB: THREE.Vector3): { origin: THREE.Vector3; normal: THREE.Vector3; gap: number } | { error: string } {
  const normal = normalA.clone().normalize();
  // Topology normals are stored to five decimals, then transformed into the document frame.
  if (normal.lengthSq() === 0 || normalB.lengthSq() === 0 || normal.clone().cross(normalB.clone().normalize()).length() > 2e-5) {
    return { error: 'The two faces are not parallel.' };
  }
  const separation = normal.dot(b.clone().sub(a));
  return { origin: a.clone().addScaledVector(normal, separation / 2), normal, gap: Math.abs(separation) };
}
