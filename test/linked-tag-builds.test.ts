import assert from 'node:assert/strict';
import test from 'node:test';
import { groupActivity } from '../src/activity.ts';
import type { ActivityEvent } from '../src/activity.ts';
import { linkedTagBuilds } from '../src/ui/linked-tag-builds.ts';

const ref = 'refs/tags/v1';
const revision = 'a'.repeat(40);
const tag = {
  id: 'tag',
  kind: 'tag',
  repoId: 'repo',
  seen: true,
  time: '2026-11-25T08:11:00Z',
  data: { evidence: 'push', change: 'created', name: ref, newObjectId: revision },
} satisfies ActivityEvent;
const build = {
  id: 'build',
  kind: 'build',
  repoId: tag.repoId,
  seen: true,
  time: '2026-11-25T08:29:00Z',
  data: { buildId: 1, status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: ref, sourceVersion: revision },
} satisfies ActivityEvent;

test('a lightweight tag links to the one successful CI run of its exact revision', () => {
  const links = linkedTagBuilds(groupActivity([tag, build]));
  assert.equal(links.size, 1);
  assert.equal(links.get(tag.id)?.id, build.id);
});

test('tag CI stays standalone when evidence, status, or visibility differs', () => {
  const cases: [string, ActivityEvent[]][] = [
    ['another repository', [tag, { ...build, repoId: 'other' }]],
    ['another revision', [tag, { ...build, data: { ...build.data, sourceVersion: 'b'.repeat(40) } }]],
    ['an earlier build', [tag, { ...build, time: '2026-11-25T08:00:00Z' }]],
    ['a failed run', [tag, { ...build, data: { ...build.data, result: 'failed' } }]],
    ['an active run', [tag, { ...build, data: { ...build.data, status: 'inProgress' } }]],
    ['a manual run', [tag, { ...build, data: { ...build.data, reason: 'manual' } }]],
    ['an unread tag', [{ ...tag, seen: false }, build]],
    ['an unread build', [tag, { ...build, seen: false }]],
    ['a second run of the same revision', [tag, build, { ...build, id: 'rerun', data: { ...build.data, buildId: 2 } }]],
    ['a second change to the same tag', [tag, build, { ...tag, id: 'move', data: { ...tag.data, change: 'moved' } }]],
  ];
  for (const [label, events] of cases) assert.equal(linkedTagBuilds(groupActivity(events)).size, 0, label);
});
