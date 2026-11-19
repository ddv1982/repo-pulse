import test from 'node:test';
import assert from 'node:assert/strict';
import { isSavedFilterModified } from '../src/ui/saved-filters.js';

test('saved filter comparison ignores removed repositories and set order while retaining a dynamic All scope', () => {
  const watched = [{ id: 'one' }, { id: 'two' }];
  const saved = { search: 'orders', people: '', kind: '', view: 'all', repoIds: ['one', 'removed', 'two'] };
  const current = { ...saved, repoIds: ['two', 'one'] };
  assert.equal(isSavedFilterModified(saved, current, watched), false);
  assert.equal(isSavedFilterModified(saved, { ...current, repoIds: null }, watched), true);
  assert.equal(isSavedFilterModified(saved, { ...current, view: 'new' }, watched), true);
});
