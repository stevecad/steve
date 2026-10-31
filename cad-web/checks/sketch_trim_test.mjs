import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trim } from '../src/sketch/trim.ts';
import { expand, stmt, lit } from '../src/sketch/model.ts';
import { loadSolver } from '../src/sketch/solver/index.ts';

const apply = (source, id, at) => {
  const result = trim(source, id, at);
  assert.ok(!('error' in result), JSON.stringify(result));
  return [...result.statements, ...result.ties];
};
const circleAndLine = (reverse = false) => [
  stmt('circle', ['c', [0, 0], 10]),
  stmt('diameter', ['c', 20]),
  stmt('coincident', ['origin', 'c.center']),
  stmt('line', ['l', reverse ? [15, 0] : [-15, 0], reverse ? [-15, 0] : [15, 0]]),
];

test('trimmed arc and chord stay connected when resized, in either line direction', async () => {
  const solver = await loadSolver();
  for (const reverse of [false, true]) {
    let source = apply(circleAndLine(reverse), 'c', [0, -10]);
    source = apply(source, 'l', [-12, 0]);
    source = apply(source, 'l', [12, 0]);
    source = source.map(s => s.op === 'diameter' ? { ...s, args: [s.args[0], lit(24)] } : s);
    const expanded = expand(source);
    const result = solver.solve({ entities: expanded.entities, constraints: expanded.constraints });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.redundant, []);
    assert.deepEqual(result.conflicting, []);
    const arc = result.entities.find(e => e.id === 'c');
    const line = result.entities.find(e => e.id === 'l');
    assert.ok(Math.abs(arc.radius - 12) < 1e-6);
    for (const angle of [arc.start_angle, arc.end_angle]) {
      const p = [arc.center[0] + arc.radius * Math.cos(angle), arc.center[1] + arc.radius * Math.sin(angle)];
      assert.ok(Math.min(...[line.start, line.end].map(q => Math.hypot(p[0] - q[0], p[1] - q[1]))) < 1e-5);
    }
  }
});

test('replacing an endpoint tie preserves unrelated point-on-line constraints', () => {
  let source = apply(circleAndLine(), 'c', [0, -10]);
  source.push(stmt('point', ['p', [3, 0]], { construction: lit(true) }), stmt('point_on', ['p', 'l']));
  source = apply(source, 'l', [-12, 0]);
  assert.ok(source.some(s => s.op === 'point_on' && s.args[0].value === 'p' && s.args[1].value === 'l'));
  assert.ok(source.some(s => s.op === 'coincident' && s.args.some(a => a.value === 'l.start')));
  assert.ok(!source.some(s => s.op === 'point_on' && s.args[0].value === 'c.end' && s.args[1].value === 'l'));
});

test('trimming a middle segment still creates two collinear pieces with crossing ties', () => {
  const source = [stmt('line', ['l', [-20, 0], [20, 0]]),
    stmt('line', ['a', [-5, -10], [-5, 10]]), stmt('line', ['b', [5, -10], [5, 10]])];
  const result = apply(source, 'l', [0, 0]);
  const expansion = expand(result);
  const horizontal = expansion.entities.filter(e => e.type === 'line' && e.start[1] === 0 && e.end[1] === 0);
  assert.equal(horizontal.length, 2);
  assert.deepEqual(horizontal.map(e => [e.start[0], e.end[0]]), [[-20, -5], [5, 20]]);
  assert.equal(expansion.constraints.filter(c => c.type === 'collinear').length, 1);
  assert.equal(expansion.constraints.filter(c => c.type === 'point_on').length, 2);
});
