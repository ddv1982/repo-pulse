import test from 'node:test';
import assert from 'node:assert/strict';
import { groupActivity, type ActivityEvent, type ActivityKind, type EventData } from '../src/activity.ts';
import { present, stub } from './fixtures/typed.ts';

const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
const build = (id: string, status: string, minute: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  repoId: 'one',
  kind: 'build',
  time: at(0),
  observedAt: at(minute),
  seen: false,
  imported: false,
  data: { buildId: 42, status, sourceVersion: 'same-commit' },
  ...extra,
});
const zero = '0'.repeat(40),
  sha = 'a'.repeat(40),
  name = 'refs/heads/hotfix/one';
function lifecycle(kind: ActivityKind = 'branch-deleted', repoId = 'one', pushId = 7) {
  const ref = { name, oldObjectId: kind === 'branch-created' ? zero : sha, newObjectId: kind === 'branch-created' ? sha : zero };
  const push = {
    id: `${repoId}-push-${pushId}`,
    kind: 'push',
    repoId,
    observedAt: at(1),
    time: at(0),
    data: { pushId, refUpdates: [ref], commits: [] },
  } satisfies ActivityEvent;
  const branch = {
    id: `${repoId}-${kind}-${pushId}`,
    kind,
    repoId,
    observedAt: at(1),
    time: at(0),
    data: { pushId, evidence: 'push', ...ref },
  } satisfies ActivityEvent;
  const events: [typeof push, typeof branch] = [push, branch];
  return events;
}

test('one build row represents queued/running/completed while keeping every exact raw event', () => {
  const input = [build('queued', 'notStarted', 1), build('completed', 'completed', 3), build('running', 'inProgress', 2)];
  const before = structuredClone(input);
  const item = present(groupActivity(input)[0]);
  assert.equal(item.id, 'completed');
  assert.deepEqual(
    item.events.map(event => event.data?.status),
    ['completed', 'inProgress', 'notStarted'],
  );
  assert.deepEqual(item.eventIds, ['completed', 'running', 'queued']);
  assert.deepEqual(item.unseenIds, ['completed', 'running', 'queued']);
  assert.equal(item.unseen, true);
  assert.equal(item.seen, false);
  assert.deepEqual(input, before, 'sorting and aggregation must not mutate source records');
  assert.equal(item.events[0], input[1], 'raw records keep their identity');
});

test('an older unseen update remains unseen when its newest representative is seen', () => {
  const first = build('queued', 'notStarted', 1);
  const second = build('running', 'inProgress', 2, { seen: true });
  const item = present(groupActivity([first, second])[0]);
  assert.equal(item.id, 'running');
  assert.equal(item.unseen, true);
  assert.equal(item.seen, false);
  assert.deepEqual(item.unseenIds, ['queued']);
  assert.equal(present(item.events[0]).seen, true, 'raw per-event acknowledgement is not rewritten');
  const seen = present(groupActivity([{ ...first, seen: true }, second])[0]);
  assert.equal(seen.unseen, false);
  const later = build('completed', 'completed', 3);
  const updated = present(groupActivity([{ ...first, seen: true }, second, later])[0]);
  assert.deepEqual(updated.unseenIds, ['completed']);
  assert.equal(updated.groupKey, item.groupKey, 'new updates keep the stable display identity');
});

test('imported history stays history and does not make a later live update read', () => {
  const imported = build('old', 'notStarted', 1, { imported: true, seen: true });
  const history = present(groupActivity([imported])[0]);
  assert.equal(history.imported, true);
  assert.equal(history.unseen, false);
  const live = present(groupActivity([imported, build('new', 'inProgress', 2)])[0]);
  assert.equal(live.imported, false);
  assert.deepEqual(live.unseenIds, ['new']);
});

test('different runs on the same commit and identical run IDs in different repos stay separate', () => {
  const first = build('one', 'completed', 1);
  const second = build('two', 'completed', 2, { data: { buildId: 43, sourceVersion: 'same-commit' } });
  const third = build('three', 'completed', 3, { repoId: 'other' });
  assert.deepEqual(
    groupActivity([first, second, third]).map(item => item.id),
    ['three', 'two', 'one'],
  );
});

test('missing or malformed run IDs do not merge unrelated records', () => {
  // Malformed on purpose: null is not a run ID the type allows.
  const input = [undefined, null, 0, 'bad', -1].map((buildId, index) =>
    build(`e${index}`, 'completed', index, { data: { buildId } as EventData }),
  );
  assert.equal(groupActivity(input).length, input.length);
  assert.equal(
    groupActivity([
      build('fallback-a', 'notStarted', 1, { data: { id: 12 } }),
      build('fallback-b', 'inProgress', 2, { data: { id: '12' } }),
    ]).length,
    1,
  );
});

test('source observation time outranks old author/event time, with deterministic ties', () => {
  const older = build('a', 'notStarted', 1, { time: at(9) });
  const newer = build('b', 'inProgress', 2, { time: at(0) });
  assert.equal(present(groupActivity([older, newer])[0]).id, 'b');
  const same = build('c', 'inProgress', 2);
  assert.deepEqual(groupActivity([newer, same]), groupActivity([same, newer]));
});

for (const kind of ['branch-deleted'] as const) {
  test(`${kind} absorbs only its exact lifecycle-only supporting push`, () => {
    const input = lifecycle(kind);
    const item = present(groupActivity(input)[0]);
    assert.equal(item.kind, kind);
    assert.equal(item.events.length, 2);
    assert.deepEqual(new Set(item.eventIds), new Set(input.map(event => event.id)));
    assert.equal(item.unseen, true);
    const single = present(groupActivity([input[1]])[0]);
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
  ])
    assert.equal(groupActivity([{ ...push, data }, branch]).length, 2);
  assert.equal(groupActivity([{ ...push, repoId: 'other' }, branch]).length, 2);
  assert.equal(groupActivity([push, { ...branch, data: { name, evidence: 'snapshot' } }]).length, 2);
});

test('unrelated PRs and pushes remain individual records without source assumptions', () => {
  const input = [
    stub<ActivityEvent>({ id: 'pr-one', repoId: 'one', kind: 'pr', observedAt: at(2), data: { pullRequestId: 1 } }),
    stub<ActivityEvent>({ id: 'pr-two', repoId: 'one', kind: 'pr', observedAt: at(1), data: { pullRequestId: 1 } }),
    stub<ActivityEvent>({ id: 'push', repoId: 'one', kind: 'push', observedAt: at(0), data: { pushId: 7 } }),
  ];
  assert.equal(groupActivity(input).length, 3);
  assert.deepEqual(groupActivity([]), []);
});

test('a retired evidence filter restored from an older session shows all activity', async () => {
  const { parseActivityFilter, activityFilterLabel } = await import('../src/activity-text.ts');
  assert.deepEqual(parseActivityFilter('evidence:merge-commit'), { type: 'all' });
  assert.equal(activityFilterLabel('evidence:merge-commit'), 'All types');
  assert.deepEqual(parseActivityFilter('evidence:pr-linked'), { type: 'evidence', id: 'pr-linked' });
});

test('activitySearchText indexes named searchable fields and drops raw JSON payload noise', async () => {
  const { activitySearchText } = await import('../src/activity-text.ts');
  // Raw provider fields the event type leaves out, which the search text must drop.
  const buildData = {
    buildId: 99,
    status: 'completed',
    result: 'succeeded',
    reason: 'individualCI',
    sourceVersion: 'deadbeef1234',
    definition: { name: 'Release Pipeline', url: 'https://dev.azure.com/org/_apis/build/Definitions/7', revision: 42 },
    repositoryId: 'internal-guid-noise',
  };
  const buildText = activitySearchText({
    id: 'b-1',
    repoId: 'r-1',
    kind: 'build',
    time: at(1),
    title: 'CI build #99',
    actor: 'Ada',
    branch: 'refs/heads/main',
    data: buildData,
  });
  assert.match(buildText, /release pipeline/);
  assert.match(buildText, /deadbeef1234/);
  assert.match(buildText, /\b99\b/);
  assert.match(buildText, /succeeded/);
  assert.match(buildText, /individualci/);
  assert.doesNotMatch(buildText, /internal-guid-noise/);
  assert.doesNotMatch(buildText, /_apis\/build\/definitions/);
  assert.doesNotMatch(buildText, /"definition"/);

  const pushText = activitySearchText({
    id: 'p-1',
    repoId: 'r-1',
    kind: 'push',
    time: at(2),
    actor: 'Ben',
    branch: 'refs/heads/main',
    data: {
      pushId: 501,
      refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'aaaa1111', newObjectId: 'bbbb2222' }],
      commits: [{ commitId: 'cccc3333', comment: 'Fix billing retry' }],
      mergeEvidence: {
        prs: [
          {
            pullRequestId: 77,
            sourceRefName: 'refs/heads/feat',
            targetRefName: 'refs/heads/main',
            mergeCommit: 'bbbb2222',
            mergeStrategy: 'squash',
            closedBy: 'Cara',
          },
        ],
        commits: [{ commitId: 'dddd4444', parents: ['7777aaaa'], branches: ['refs/heads/topic-a'] }],
        introducedCommitIds: ['eeee5555'],
        refRanges: [{ name: 'refs/heads/main', commitIds: ['ffff6666'] }],
        rewrite: [{ ref: 'refs/heads/main', status: 'rewrite', dropped: 2 }],
      },
    },
  });
  for (const needle of [
    '501',
    'bbbb2222',
    'cccc3333',
    'fix billing retry',
    '77',
    'squash',
    'cara',
    'dddd4444',
    '7777aaaa',
    'refs/heads/topic-a',
    'eeee5555',
    'ffff6666',
    'history rewritten',
  ])
    assert.ok(pushText.includes(needle), `expected search text to include ${needle}`);
  assert.doesNotMatch(pushText, /"mergeevidence"/);
});
