import test from 'node:test';
import assert from 'node:assert/strict';
import { groupActivity } from '../src/activity.js';

const at = minute => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
const build = (id, status, minute, extra = {}) => ({ id, repoId: 'one', kind: 'build', time: at(0), observedAt: at(minute),
  seen: false, imported: false, data: { buildId: 42, status, sourceVersion: 'same-commit' }, ...extra });
const zero = '0'.repeat(40), sha = 'a'.repeat(40), name = 'refs/heads/hotfix/one';
function lifecycle(kind = 'branch-deleted', repoId = 'one', pushId = 7) {
  const ref = { name, oldObjectId: kind === 'branch-created' ? zero : sha, newObjectId: kind === 'branch-created' ? sha : zero };
  return [
    { id: `${repoId}-push-${pushId}`, kind: 'push', repoId, observedAt: at(1), time: at(0), data: { pushId, refUpdates: [ref], commits: [] } },
    { id: `${repoId}-${kind}-${pushId}`, kind, repoId, observedAt: at(1), time: at(0), data: { pushId, evidence: 'push', ...ref } },
  ];
}

test('one build row represents queued/running/completed while keeping every exact raw event', () => {
  const input = [build('queued', 'notStarted', 1), build('completed', 'completed', 3), build('running', 'inProgress', 2)];
  const before = structuredClone(input);
  const [item] = groupActivity(input);
  assert.equal(item.id, 'completed');
  assert.deepEqual(item.events.map(event => event.data.status), ['completed', 'inProgress', 'notStarted']);
  assert.deepEqual(item.eventIds, ['completed', 'running', 'queued']);
  assert.deepEqual(item.unseenIds, ['completed', 'running', 'queued']);
  assert.equal(item.unseen, true); assert.equal(item.seen, false);
  assert.deepEqual(input, before, 'sorting and aggregation must not mutate source records');
  assert.equal(item.events[0], input[1], 'raw records keep their identity');
});

test('an older unseen update remains unseen when its newest representative is seen', () => {
  const first = build('queued', 'notStarted', 1);
  const second = build('running', 'inProgress', 2, { seen: true });
  const [item] = groupActivity([first, second]);
  assert.equal(item.id, 'running'); assert.equal(item.unseen, true); assert.equal(item.seen, false);
  assert.deepEqual(item.unseenIds, ['queued']);
  assert.equal(item.events[0].seen, true, 'raw per-event acknowledgement is not rewritten');
  const [seen] = groupActivity([{ ...first, seen: true }, second]);
  assert.equal(seen.unseen, false);
  const later = build('completed', 'completed', 3);
  const [updated] = groupActivity([{ ...first, seen: true }, second, later]);
  assert.deepEqual(updated.unseenIds, ['completed']);
  assert.equal(updated.groupKey, item.groupKey, 'new updates keep the stable display identity');
});

test('imported history stays history and does not make a later live update read', () => {
  const imported = build('old', 'notStarted', 1, { imported: true, seen: true });
  const [history] = groupActivity([imported]);
  assert.equal(history.imported, true); assert.equal(history.unseen, false);
  const [live] = groupActivity([imported, build('new', 'inProgress', 2)]);
  assert.equal(live.imported, false); assert.deepEqual(live.unseenIds, ['new']);
});

test('different runs on the same commit and identical run IDs in different repos stay separate', () => {
  const first = build('one', 'completed', 1);
  const second = build('two', 'completed', 2, { data: { buildId: 43, sourceVersion: 'same-commit' } });
  const third = build('three', 'completed', 3, { repoId: 'other' });
  assert.deepEqual(groupActivity([first, second, third]).map(item => item.id), ['three', 'two', 'one']);
});

test('missing or malformed run IDs do not merge unrelated records', () => {
  const input = [undefined, null, 0, 'bad', -1].map((buildId, index) => build(`e${index}`, 'completed', index, { data: { buildId } }));
  assert.equal(groupActivity(input).length, input.length);
  assert.equal(groupActivity([build('fallback-a', 'notStarted', 1, { data: { id: 12 } }), build('fallback-b', 'inProgress', 2, { data: { id: '12' } })]).length, 1);
});

test('source observation time outranks old author/event time, with deterministic ties', () => {
  const older = build('a', 'notStarted', 1, { time: at(9) });
  const newer = build('b', 'inProgress', 2, { time: at(0) });
  assert.equal(groupActivity([older, newer])[0].id, 'b');
  const same = build('c', 'inProgress', 2);
  assert.deepEqual(groupActivity([newer, same]), groupActivity([same, newer]));
});

for (const kind of ['branch-deleted']) {
  test(`${kind} absorbs only its exact lifecycle-only supporting push`, () => {
    const input = lifecycle(kind);
    const [item] = groupActivity(input);
    assert.equal(item.kind, kind); assert.equal(item.events.length, 2);
    assert.deepEqual(new Set(item.eventIds), new Set(input.map(event => event.id)));
    assert.equal(item.unseen, true);
    const [single] = groupActivity([input[1]]);
    assert.equal(single.groupKey, item.groupKey, 'filtering away the push keeps the branch group identity');
  });
}

test('new-branch pushes stay separate because an empty cached commit list is not complete coverage', () => {
  assert.equal(groupActivity(lifecycle('branch-created')).length, 2);
});

test('branch folding preserves multi-ref pushes, commits and unproven source facts', () => {
  const [push, branch] = lifecycle();
  const extraRef = { name: 'refs/heads/main', oldObjectId: sha, newObjectId: 'b'.repeat(40) };
  for (const data of [
    { ...push.data, refUpdates: [...push.data.refUpdates, extraRef] },
    { ...push.data, commits: [{ commitId: sha, comment: 'Actual additional work' }] },
    { ...push.data, commits: undefined },
    { ...push.data, pushId: 8 },
    { ...push.data, refUpdates: [{ ...push.data.refUpdates[0], name: 'refs/heads/other' }] },
  ]) assert.equal(groupActivity([{ ...push, data }, branch]).length, 2);
  assert.equal(groupActivity([{ ...push, repoId: 'other' }, branch]).length, 2);
  assert.equal(groupActivity([push, { ...branch, data: { name, evidence: 'snapshot' } }]).length, 2);
});

test('unrelated PRs and pushes remain individual records without source assumptions', () => {
  const input = [
    { id: 'pr-one', repoId: 'one', kind: 'pr', observedAt: at(2), data: { pullRequestId: 1 } },
    { id: 'pr-two', repoId: 'one', kind: 'pr', observedAt: at(1), data: { pullRequestId: 1 } },
    { id: 'push', repoId: 'one', kind: 'push', observedAt: at(0), data: { pushId: 7 } },
  ];
  assert.equal(groupActivity(input).length, 3);
  assert.deepEqual(groupActivity([]), []);
});
