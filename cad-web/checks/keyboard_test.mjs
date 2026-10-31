import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveBindings, PRESETS } from '../src/settings/keyboard.ts';
const defaults = { 'view.fit': ['f'], 'model.fillet': ['shift+f'], 'inspect.measure': ['m'], 'model.move': ['shift+m'], 'sketch.spline': ['s'], 'app.palette': ['mod+k'] };
test('Steve defaults are unchanged, including aliases', () => assert.deepEqual(resolveBindings(defaults, 'steve', {}), defaults));
test('Fusion claims displace conflicting inherited keys', () => {
 const keys = resolveBindings(defaults, 'fusion', {});
 assert.deepEqual(keys['model.fillet'], ['f']); assert.deepEqual(keys['view.fit'], []);
 assert.deepEqual(keys['model.move'], ['m']); assert.deepEqual(keys['inspect.measure'], ['i']);
 assert.deepEqual(keys['sketch.spline'], []);
});
test('custom unassignment and reset remain distinct', () => {
 assert.deepEqual(resolveBindings(defaults, 'steve', {'view.fit': []})['view.fit'], []);
 assert.deepEqual(resolveBindings(defaults, 'steve', {})['view.fit'], ['f']);
});
test('presets contain no ambiguous explicit assignments', () => {
 for (const preset of Object.values(PRESETS)) {
  const keys = Object.values(preset).flat(); assert.equal(new Set(keys).size, keys.length);
 }
});
