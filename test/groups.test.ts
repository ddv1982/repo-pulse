import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_GROUP, IMPORTED_GROUP, createGroupState, disclosure } from '../src/ui/groups.ts';

test('a stored results context that names Activity groups by title restores them by stable ID', () => {
  const groups = createGroupState();
  groups.restore([
    ['New updates', false],
    ['Imported history', true],
    ['ci-key', true],
  ]);
  assert.deepEqual(Object.fromEntries(groups.open), { [ACTIVITY_GROUP]: false, [IMPORTED_GROUP]: true, 'ci-key': true });
  groups.restore([['Activity', true]]);
  assert.equal(groups.open.get(ACTIVITY_GROUP), true);
});

test('a disclosure keeps the state it first rendered with while it stays, and starts again when it comes back', () => {
  const groups = createGroupState();
  assert.equal(String(disclosure(groups.open, IMPORTED_GROUP, true)), 'data-group="imported-history" open');
  groups.settle([[IMPORTED_GROUP, true]]);
  // Its default now says closed, as when the first live row arrives, but it stays as it was.
  assert.equal(String(disclosure(groups.open, IMPORTED_GROUP, false)), 'data-group="imported-history" open');
  groups.toggle('repo-orders', true);
  groups.settle([['repo-orders', true]]);
  assert.equal(groups.open.has(IMPORTED_GROUP), false);
  assert.equal(String(disclosure(groups.open, IMPORTED_GROUP, false)), 'data-group="imported-history" ');
});

test('the reader opening or closing Imported history lasts after it leaves the page', () => {
  const groups = createGroupState();
  groups.toggle(IMPORTED_GROUP, false);
  groups.settle([]);
  assert.equal(groups.open.get(IMPORTED_GROUP), false);
  // A stored results context does not override the reader's choice.
  groups.restore([['Imported history', true]]);
  assert.equal(groups.open.get(IMPORTED_GROUP), false);
});
