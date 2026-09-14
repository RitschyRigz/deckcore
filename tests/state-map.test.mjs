import test from 'node:test';
import assert from 'node:assert/strict';
import { renameStateKey } from '../web/state-map.mjs';

test('collisions in either order preserve every action', () => {
  for (const map of [{hold:'a', final:'b'}, {final:'b', hold:'a'}]) {
    const before = {...map};
    assert.throws(() => renameStateKey(map, 'hold', 'final'), /bereits/);
    assert.deepEqual(map, before);
  }
});
test('reserved and empty names never replace the fallback', () => {
  const map = {hold:'a', '*':'fallback'};
  for (const name of ['*', '', '   ']) assert.throws(() => renameStateKey(map, 'hold', name));
  assert.deepEqual(map, {hold:'a', '*':'fallback'});
});
test('new status keeps actions, deliberate no-op and fallback', () => {
  const map = {hold:'a', final:'', '*':'fallback'};
  assert.deepEqual(renameStateKey(map, 'hold', 'custom_phase'),
                   {custom_phase:'a', final:'', '*':'fallback'});
  assert.deepEqual(renameStateKey(map, 'hold', 'hold'), map);
  assert.deepEqual(renameStateKey(map, 'hold', '__proto__'),
                   JSON.parse('{"__proto__":"a","final":"","*":"fallback"}'));
});
