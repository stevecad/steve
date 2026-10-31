// The Surface tab's analysis maths (web/src/viewport/surfaceAnalysis.ts), without a browser: curvature estimated on a
// face's mesh (a sphere, a cylinder, a flat), draft angles and bands against a pull direction (a known cone), and the
// G0 / G1 / G2 continuity of two faces along an edge.
//
//   node --test checks/surface_analysis_test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acrossEdge, chordCurvature, continuity, curvatureToward, curvatures, draftAngle, draftBand, exactCurvature, neighbours, TOLERANCE,
} from '../src/viewport/surfaceAnalysis.ts';

const close = (actual, expected, label, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ≠ ${expected} (± ${tolerance})`);

/** A grid of rows × columns nodes from `point(u, v)` and `normal(u, v)` (u, v in 0..1), two triangles per cell. */
function grid(rows, columns, point, normal) {
  const positions = [], normals = [], index = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= columns; c++) {
      positions.push(...point(c / columns, r / rows));
      normals.push(...normal(c / columns, r / rows));
    }
  }
  const node = (r, c) => r * (columns + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) index.push(node(r, c), node(r, c + 1), node(r + 1, c + 1), node(r, c), node(r + 1, c + 1), node(r + 1, c));
  }
  return { positions, normals, index, node };
}

/** A band of a sphere of radius R around its equator (no poles, where a UV mesh bunches up). */
const sphere = (R) => grid(24, 48, (u, v) => {
  const lon = u * 2 * Math.PI, lat = (v - 0.5) * 1.2;
  return [R * Math.cos(lat) * Math.cos(lon), R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat)];
}, (u, v) => {
  const lon = u * 2 * Math.PI, lat = (v - 0.5) * 1.2;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
});

/** A cylinder of radius R about Z, 0 to h high; `inward` flips its normals (a bore). */
const cylinder = (R, h, inward = false) => grid(10, 72, (u, v) => [R * Math.cos(u * 2 * Math.PI), R * Math.sin(u * 2 * Math.PI), v * h],
  (u) => { const s = inward ? -1 : 1; return [s * Math.cos(u * 2 * Math.PI), s * Math.sin(u * 2 * Math.PI), 0]; });

/** Interior nodes of a grid (away from its open rows, where a node has neighbours on one side only). */
const interior = (mesh, rows, columns) => {
  const out = [];
  for (let r = 1; r < rows; r++) for (let c = 1; c < columns; c++) out.push(mesh.node(r, c));
  return out;
};

test('the chord curvature of a circle is 1/R, positive outside it and negative inside', () => {
  const R = 7;
  const p = [R, 0, 0], q = [R * Math.cos(0.3), R * Math.sin(0.3), 0];
  close(chordCurvature(p, [1, 0, 0], q), 1 / R, 'outside', 1e-12);
  close(chordCurvature(p, [-1, 0, 0], q), -1 / R, 'inside', 1e-12);
  close(chordCurvature([0, 0, 0], [0, 0, 1], [3, 4, 0]), 0, 'flat', 1e-12);
});

test('a sphere: mean curvature 1/R and Gaussian 1/R² at every node', () => {
  const R = 20;
  const mesh = sphere(R);
  const values = curvatures(mesh);
  for (const i of interior(mesh, 24, 48)) {
    close(values[2 * i], 1 / R, `H at node ${i}`, 0.01 / R);
    close(values[2 * i + 1], 1 / (R * R), `K at node ${i}`, 0.03 / (R * R));
  }
});

test('a cylinder: mean curvature 1/2R and Gaussian 0; a bore the same with the sign turned', () => {
  const R = 5;
  for (const [mesh, sign] of [[cylinder(R, 12), 1], [cylinder(R, 12, true), -1]]) {
    const values = curvatures(mesh);
    for (const i of interior(mesh, 10, 72)) {
      close(values[2 * i], sign / (2 * R), `H at node ${i}`, 0.005 / R);
      close(values[2 * i + 1], 0, `K at node ${i}`, 1e-6);
    }
  }
});

test('a flat face has no curvature', () => {
  const mesh = grid(4, 4, (u, v) => [u * 10, v * 10, 3], () => [0, 0, 1]);
  const values = curvatures(mesh);
  assert.ok(values.every((value) => Math.abs(value) < 1e-12), 'flat');
});

test('draft angles on a cone: its half angle against its axis, the side facing the other way negative', () => {
  // A cone opening upward with a 5° wall: its outer normals lean 5° up from horizontal.
  const half = (5 * Math.PI) / 180;
  for (let k = 0; k < 12; k++) {
    const around = (k / 12) * 2 * Math.PI;
    const normal = [Math.cos(half) * Math.cos(around), Math.cos(half) * Math.sin(around), Math.sin(half)];
    close(draftAngle(normal, [0, 0, 1]), 5, 'pulled up', 1e-9);
    close(draftAngle(normal, [0, 0, -1]), -5, 'pulled down', 1e-9);
  }
  close(draftAngle([1, 0, 0], [0, 0, 1]), 0, 'vertical wall', 1e-12);
  close(draftAngle([0, 0, 2], [0, 0, 1]), 90, 'top face (normals need not be unit)', 1e-12);
  assert.equal(draftBand(5, 1), 'positive');
  assert.equal(draftBand(0.5, 1), 'shallow');
  assert.equal(draftBand(-0.5, 1), 'shallow');
  assert.equal(draftBand(-3, 1), 'negative');
  assert.equal(draftBand(1, 1), 'positive', 'the minimum itself is enough');
});

test('exact curvature across an edge: plane 0, sphere 1/R, cylinder (d across the axis)² / R, a bore negative', () => {
  close(exactCurvature({ kind: 'plane' }, [0, 0, 0], [0, 0, 1], [1, 0, 0]), 0, 'plane', 0);
  close(exactCurvature({ kind: 'sphere', center: [0, 0, 0], radius: 4 }, [4, 0, 0], [1, 0, 0], [0, 1, 0]), 0.25, 'sphere', 1e-12);
  const shaft = { kind: 'cylinder', point: [0, 0, -3], axis: [0, 0, 2], radius: 5 };
  close(exactCurvature(shaft, [5, 0, 1], [1, 0, 0], [0, 1, 0]), 0.2, 'around a shaft', 1e-12);
  close(exactCurvature(shaft, [5, 0, 1], [1, 0, 0], [0, 0, 1]), 0, 'along a shaft', 1e-12);
  close(exactCurvature(shaft, [5, 0, 1], [-1, 0, 0], [0, 1, 0]), -0.2, 'around a bore', 1e-12);
});

test('curvature towards a direction picks the neighbour lined up with it', () => {
  const R = 5;
  const mesh = cylinder(R, 12);
  const around = neighbours(mesh);
  const i = mesh.node(5, 0);   // at (R, 0, 6), normal +X
  close(curvatureToward(mesh, around, i, [0, 1, 0]), 1 / R, 'around', 0.01 / R);
  close(curvatureToward(mesh, around, i, [0, 0, 1]), 0, 'along', 1e-9);
  assert.deepEqual(acrossEdge([0, 0, 1], [1, 0, 0], [0, -2, 0]), [-0, -1, -0]);
});

/** One side of an edge along X at y = 0, with the same normal and curvature at every point. */
const side = (normal, across, offset = [0, 0, 0], exact = true) => ({
  points: Array.from({ length: 9 }, (_, i) => [i + offset[0], offset[1], offset[2]]),
  normals: Array.from({ length: 9 }, () => normal),
  across: Array.from({ length: 9 }, () => across),
  exactCurvature: exact,
});

test('continuity: G2, G1, G0 and apart, with the gap, the angle and the worst point', () => {
  assert.equal(continuity(side([0, 0, 1], 0.1), side([0, 0, 1], 0.1)).grade, 'G2');
  const g1 = continuity(side([0, 0, 1], 0), side([0, 0, 1], 0.1));
  assert.equal(g1.grade, 'G1', 'a flat meeting a curve tangentially (a fillet on a wall)');
  close(g1.curvature, 0.1, 'curvature jump', 1e-12);
  const crease = Math.sin((30 * Math.PI) / 180);
  const g0 = continuity(side([0, 0, 1], 0), side([0, crease, Math.cos((30 * Math.PI) / 180)], 0));
  assert.equal(g0.grade, 'G0');
  close(g0.angle, 30, 'crease angle', 1e-9);
  const apart = continuity(side([0, 0, 1], 0), side([0, 0, 1], 0, [0, 0.5, 0]));
  assert.equal(apart.grade, 'none');
  close(apart.gap, 0.5, 'gap', 1e-12);
  assert.ok(continuity(side([0, 0, 1], 0), side([0, 0, 1], 0, [0, TOLERANCE.gap / 2, 0])).grade === 'G2', 'within the gap tolerance');
  // A kink at one point only: the worst point is there.
  const kinked = side([0, 0, 1], 0);
  kinked.normals = kinked.normals.map((n, i) => (i === 6 ? [0, Math.sin(0.01), Math.cos(0.01)] : n));
  const found = continuity(side([0, 0, 1], 0), kinked);
  assert.deepEqual(found.worst, [6, 0, 0]);
  assert.equal(found.grade, 'G0', '0.57° is past the tangent tolerance');
  assert.equal(continuity(side([0, 0, 1], null), side([0, 0, 1], 0)).curvature, null, 'no curvature where the mesh can’t say');
  assert.equal(continuity(side([0, 0, 1], 0, [0, 0, 0], false), side([0, 0, 1], 0)).exactCurvature, false);
  assert.equal(continuity({ points: [], normals: [], across: [], exactCurvature: true }, side([0, 0, 1], 0)), null);
});

test('a build\'s exact measurement grades like the mesh check, every value exact', async () => {
  const { fromMeasured, gradeOf } = await import('../src/viewport/surfaceAnalysis.ts');
  // A fillet against its flat face: no gap, no angle, curvature 1/8 against 0: tangent, not G2.
  const fillet = fromMeasured({ faces: [0, 1], gap: 0, angle: 0, change: 0.125, relative: 1, curvature: [0.125, 0], at: [1, 2, 3], samples: 5 });
  assert.equal(fillet.grade, 'G1');
  assert.ok(fillet.exact && fillet.exactCurvature);
  assert.deepEqual(fillet.worst, [1, 2, 3]);
  // Matching curvature within 5 %: G2.
  assert.equal(fromMeasured({ faces: [0, 1], gap: 0, angle: 0.01, change: 0.004, relative: 0.03, curvature: [0.1, 0.104], at: [0, 0, 0], samples: 5 }).grade, 'G2');
  // A patch closing a wall: under 0.01 mm but several degrees: touching with a crease.
  assert.equal(fromMeasured({ faces: [0, 1], gap: 0.004, angle: 5.8, change: 0.1, relative: 1, curvature: [0.1, 0], at: [0, 0, 0], samples: 5 }).grade, 'G0');
  assert.equal(fromMeasured({ faces: [0, 1], gap: 0.05, angle: 0, change: 0, relative: 0, curvature: [0, 0], at: [0, 0, 0], samples: 5 }).grade, 'none');
  // Curvature unknown on one side: never claimed as G2.
  const unknown = fromMeasured({ faces: [0, 1], gap: 0, angle: 0, change: 0, relative: 0, curvature: [null, 0], at: [0, 0, 0], samples: 5 });
  assert.equal(unknown.grade, 'G1');
  assert.equal(unknown.curvature, null);
  // Both nearly flat: G2 whatever the share.
  assert.equal(gradeOf(0, 0, TOLERANCE.flat / 2, 1), 'G2');
  assert.equal(gradeOf(TOLERANCE.gap, TOLERANCE.angle, 0, 0), 'G2');
  assert.equal(gradeOf(TOLERANCE.gap * 1.01, 0, 0, 0), 'none');
});

// Regression fixture captured from the local CAD runtime's R=20 sphere.
// Pole seams contain separate mesh nodes at the same position.
import { readFileSync } from 'node:fs';
test('CAD sphere pole seams retain curvature at every vertex', () => {
  const meshes = JSON.parse(readFileSync(new URL('./sphere-curvature-mesh.json', import.meta.url)));
  for (const mesh of meshes) {
    const result = curvatures(mesh);
    for (let i = 0; i < result.length / 2; i++) {
      close(result[i * 2], .05, `H at actual sphere vertex ${i}`, .00005);
      close(result[i * 2 + 1], .0025, `K at actual sphere vertex ${i}`, .000005);
    }
  }
});
test('fully degenerate triangles remain finite', () => {
  const result = curvatures({positions:[0,0,0,0,0,0,0,0,0], normals:[0,0,1,0,0,1,0,0,1], index:[0,1,2]});
  assert.ok(result.every(v=>Number.isFinite(v)));
});
