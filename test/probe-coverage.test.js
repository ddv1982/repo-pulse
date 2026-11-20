import test from 'node:test';
import assert from 'node:assert/strict';
import { creationPushes, probeRequests, summarize } from '../scripts/probe-coverage.js';

const repo = { organization: 'https://dev.azure.com/example', project: 'Project', projectId: 'p1', azureId: 'r1' };

test('the coverage probe only builds GET requests, including the per-PR reads', () => {
  const requests = probeRequests(repo, { prId: 7 });
  assert.deepEqual(
    requests.map(request => request.name),
    [
      'tag refs',
      'pushes with ref updates',
      'active PRs',
      'PRs from this repository',
      'PR threads',
      'PR policy evaluations',
      'PR iterations',
    ],
  );
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).origin, 'https://dev.azure.com');
  }
  assert.equal(probeRequests(repo).length, 4, 'per-PR reads wait for an active PR');
});

test('probe summaries keep counts and field names, never names or IDs', () => {
  const facts = summarize(
    'PRs from this repository',
    { value: [{ pullRequestId: 3, title: 'Secret title', repository: { id: 'other', project: { id: 'p2' } } }] },
    repo,
  );
  assert.deepEqual(facts, { items: 1, fields: ['pullRequestId', 'repository', 'title'], targetOtherRepository: 1, targetOtherProject: 1 });
  assert.doesNotMatch(JSON.stringify(facts), /Secret title|other|p2/);
});

test('probe summaries replace policy and thread type names Azure did not define with "other"', () => {
  const policies = summarize(
    'PR policy evaluations',
    {
      value: [
        { status: 'approved', configuration: { type: { displayName: 'Minimum number of reviewers' } } },
        { status: 'queued', configuration: { type: { displayName: 'Pipeline payments-ci' } } },
        { status: 'payments-status', configuration: { type: { displayName: 'Build' } } },
      ],
    },
    repo,
  );
  assert.deepEqual(policies.policyTypes, ['Build', 'Minimum number of reviewers', 'other']);
  assert.deepEqual(policies.statuses, ['approved', 'other', 'queued']);
  const threads = summarize('PR threads', { value: [{ properties: { CodeReviewThreadType: { $value: 'Secret-team-type' } } }] }, repo);
  assert.deepEqual(threads.threadTypes, ['other']);
  assert.doesNotMatch(JSON.stringify([policies, threads]), /payments|Secret/);
});

test('the probe refuses an organization URL the app would not accept', () => {
  assert.throws(() => probeRequests({ ...repo, organization: 'https://attacker.example/org' }));
});

test('the fork evidence reads follow a branch creation push and an active PR, GET only', () => {
  const tip = 'a'.repeat(40);
  const requests = probeRequests(repo, {
    prId: 7,
    sourceCommit: 'b'.repeat(40),
    targetCommit: 'c'.repeat(40),
    creations: [{ pushId: 41, tip }],
  });
  const names = requests.map(request => request.name);
  assert.deepEqual(names.slice(4), [
    'PR threads',
    'PR policy evaluations',
    'PR iterations',
    'PR merge bases',
    'creation push commits',
    'created commit',
  ]);
  const byName = Object.fromEntries(requests.map(request => [request.name, new URL(request.url)]));
  assert.equal(byName['PR iterations'].pathname, '/example/Project/_apis/git/repositories/r1/pullrequests/7/iterations');
  assert.equal(byName['PR merge bases'].pathname, `/example/Project/_apis/git/repositories/r1/commits/${'b'.repeat(40)}/mergebases`);
  assert.equal(byName['PR merge bases'].searchParams.get('otherCommitId'), 'c'.repeat(40));
  assert.equal(byName['creation push commits'].searchParams.get('pushId'), '41');
  assert.equal(byName['created commit'].pathname, `/example/Project/_apis/git/repositories/r1/commits/${tip}`);
  for (const request of requests) assert.equal(request.method, 'GET');
});

test('branch creation pushes are found from the push list', () => {
  const zero = '0'.repeat(40);
  const pushes = {
    value: [
      { pushId: 9, refUpdates: [{ name: 'refs/heads/a', oldObjectId: zero, newObjectId: '1'.repeat(40) }] },
      { pushId: 8, refUpdates: [{ name: 'refs/heads/b', oldObjectId: '2'.repeat(40), newObjectId: '3'.repeat(40) }] },
      { pushId: 7, refUpdates: [{ name: 'refs/tags/t', oldObjectId: zero, newObjectId: '4'.repeat(40) }] },
    ],
  };
  assert.deepEqual(creationPushes(pushes), [{ pushId: 9, tip: '1'.repeat(40) }]);
});

test('creation push summaries say where the pushed commits leave the push, without commit IDs', () => {
  const [a, b, c, base] = ['a', 'b', 'c', 'd'].map(char => char.repeat(40));
  const facts = summarize(
    'creation push commits',
    {
      value: [
        { commitId: c, parents: [b], comment: 'secret message' },
        { commitId: b, parents: [a] },
        { commitId: a, parents: [base] },
      ],
    },
    repo,
    { tip: c },
  );
  assert.deepEqual(facts, {
    items: 3,
    fields: ['comment', 'commitId', 'parents'],
    withParents: 3,
    outsideParents: 1,
    tipFirst: true,
    newestFirst: true,
  });
  assert.doesNotMatch(JSON.stringify(facts), /aaaa|dddd|secret/);
  const iterations = summarize(
    'PR iterations',
    { value: [{ reason: 'create', commonRefCommit: { commitId: a } }, { reason: 'secret' }] },
    repo,
  );
  assert.deepEqual(iterations.reasons, ['create', 'other']);
  assert.equal(iterations.withCommonRefCommit, 1);
});
