import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRequests, summarize } from '../scripts/probe-coverage.js';

const repo = { organization: 'https://dev.azure.com/example/', project: 'Project', projectId: 'p1', azureId: 'r1' };

test('the coverage probe only builds GET requests, including the per-PR reads', () => {
  const requests = probeRequests(repo, { prId: 7 });
  assert.deepEqual(
    requests.map(request => request.name),
    ['tag refs', 'pushes with ref updates', 'active PRs', 'PRs from this repository', 'PR threads', 'PR policy evaluations'],
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
      ],
    },
    repo,
  );
  assert.deepEqual(policies.policyTypes, ['Minimum number of reviewers', 'other']);
  const threads = summarize('PR threads', { value: [{ properties: { CodeReviewThreadType: { $value: 'Secret-team-type' } } }] }, repo);
  assert.deepEqual(threads.threadTypes, ['other']);
  assert.doesNotMatch(JSON.stringify([policies, threads]), /payments|Secret/);
});
