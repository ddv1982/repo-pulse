import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createEnrichment } from '../server/enrichment.js';

const sha = value => value.repeat(40);
const old = sha('1'), merge = sha('2'), feature = sha('3'), tip = sha('4');
const BASE = Date.parse('2026-11-17T10:00:00Z');
const repo = { id: 'local', azureId: 'repo', name: 'Repo', organization: 'https://dev.azure.com/example', project: 'Project' };
const push = { id: 'push', kind: 'push', repoId: repo.id, time: '2026-11-16T10:00:00Z', observedAt: '2026-11-17T09:00:00Z', seen: true, imported: true,
  data: { pushId: 9, refUpdates: [{ name: 'refs/heads/main', oldObjectId: old, newObjectId: tip }] } };
const objects = [{ commitId: merge, parents: [old, feature] }, { commitId: tip, parents: [merge] }, { commitId: old, parents: [] }];
const completed = { pullRequestId: 7, status: 'completed', repository: { id: repo.azureId }, sourceRefName: 'refs/heads/fix', targetRefName: 'refs/heads/main', lastMergeCommit: { commitId: merge }, completionOptions: { mergeStrategy: 'noFastForward' } };

function fixture(t, custom = {}) {
  const store = createStore(); t.after(() => store.close()); store.saveRepo(repo); store.insertEvents([push]);
  let time = BASE;
  const calls = { pages: [], ranges: [], hydration: [], prs: 0 };
  const provider = {
    async pushCommits(_repo, _id, cursor) { calls.pages.push(cursor); return cursor?.skip ? { items: [{ commitId: tip }], nextCursor: null } : { items: [{ commitId: merge }], nextCursor: { skip: 1 } }; },
    async refCommits(_repo, from, to, cursor) { calls.ranges.push({ from, to, cursor }); return { items: [{ commitId: merge }, { commitId: tip }], nextCursor: null }; },
    async commitsByIds(_repo, ids) { calls.hydration.push(ids); return objects.filter(item => ids.includes(item.commitId)); },
    async queryPullRequests() { calls.prs++; return []; }, ...custom,
  };
  const enqueue = (stage, commitIds) => store.saveJob({ id: 'merge:push', type: 'merge', repoId: repo.id, eventId: push.id, status: 'pending', nextAt: new Date(time).toISOString(), stage, commitIds,
    ...(stage === 'prs' ? { rangesComplete: true, refRanges: store.getEvent(push.id).data?.mergeEvidence?.refRanges || [{ ...push.data.refUpdates[0], commitIds, complete: true }] } : {}) });
  enqueue();
  const worker = () => createEnrichment({ store, provider, now: () => time });
  return { store, provider, calls, worker, enqueue, advance(ms) { time += ms; } };
}
async function drain(store, worker, limit = 20) {
  for (let index = 0; store.listJobs({ type: 'merge' }).length && index < limit; index++) await worker.tick();
}

test('paged all-commit enrichment resumes after restart, hydrates in tiny batches and preserves raw identity/read flags', async t => {
  const f = fixture(t); let worker = f.worker();
  await worker.tick();
  assert.deepEqual(f.store.listJobs()[0].cursor, { skip: 1 });
  worker = f.worker(); await drain(f.store, worker);
  assert.equal(f.store.listJobs().length, 0); assert.deepEqual(f.calls.pages, [{}, { skip: 1 }]);
  assert.ok(f.calls.hydration.every(ids => ids.length <= 2));
  const result = f.store.getEvent('push');
  assert.equal(result.data.mergeEvidence.status, 'complete'); assert.equal(result.data.mergeEvidence.commits[0].commitId, merge);
  assert.deepEqual(result.data.mergeEvidence.introducedCommitIds, [merge, tip]);
  for (const key of ['id', 'time', 'observedAt', 'seen', 'imported']) assert.equal(result[key], push[key]);
  assert.equal(f.store.listEvents().length, 1); assert.equal(f.calls.prs, 1);
});

test('missing parent objects produce visible partial evidence and durable retry instead of root-commit assumptions', async t => {
  const f = fixture(t, { async commitsByIds() { return [{ commitId: merge }]; } });
  const worker = f.worker(); await worker.tick(); await worker.tick(); await worker.tick(); await worker.tick();
  const job = f.store.listJobs()[0], evidence = f.store.getEvent('push').data.mergeEvidence;
  assert.equal(job.status, 'retrying'); assert.equal(job.error.code, 'EVIDENCE_UNAVAILABLE');
  assert.equal(evidence.status, 'partial'); assert.equal(evidence.error.code, 'EVIDENCE_UNAVAILABLE');
  assert.equal(evidence.commits.length, 0);
});

test('new-branch/deletion-only jobs skip historical graph and PR reads', async t => {
  const f = fixture(t);
  for (const [id, ref] of [['create', { oldObjectId: sha('0'), newObjectId: merge }], ['delete', { oldObjectId: tip, newObjectId: sha('0') }]]) {
    f.store.insertEvents([{ ...push, id, data: { pushId: 10, refUpdates: [{ name: 'refs/heads/old', ...ref }] } }]);
    f.store.saveJob({ id: `merge:${id}`, type: 'merge', repoId: repo.id, eventId: id, nextAt: new Date(BASE).toISOString() });
  }
  f.store.removeJob('merge:push'); await drain(f.store, f.worker());
  assert.equal(f.calls.pages.length, 0); assert.equal(f.calls.prs, 0);
  assert.equal(f.store.getEvent('create').data.mergeEvidence.status, 'not-applicable');
  assert.deepEqual(f.store.getEvent('delete').data.mergeEvidence.commits, []);
});

test('expired negative associations are queried again and a later PR completion invalidates affected pushes', async t => {
  const f = fixture(t); const worker = f.worker(); await drain(f.store, worker);
  const ids = f.store.getEvent('push').data.mergeEvidence.introducedCommitIds;
  f.enqueue('prs', ids); await worker.tick(); assert.equal(f.calls.prs, 1, 'fresh negative cache avoids another query');
  f.advance(300001); f.enqueue('prs', ids); await drain(f.store, worker); assert.equal(f.calls.prs, 2, 'negative result is not permanent');
  f.provider.queryPullRequests = async () => { f.calls.prs++; return [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: completed }]; };
  assert.equal(worker.reconcilePr(repo, { status: 'active', mergeCommit: merge, targetRefName: completed.targetRefName }).scheduled, 0);
  assert.equal(worker.reconcilePr(repo, { status: 'completed', mergeCommit: merge, targetRefName: completed.targetRefName }).scheduled, 1);
  await drain(f.store, worker);
  assert.equal(f.calls.prs, 3);
  assert.equal(f.store.getEvent('push').data.mergeEvidence.prs[0].relationship, 'result-introduced');
  assert.equal(f.store.getEvent('push').seen, true); assert.equal(f.store.getEvent('push').imported, true);
});

test('provider failures retain positive evidence and pause/removal races do not write stale results', async t => {
  const f = fixture(t, { async queryPullRequests() { throw Object.assign(new Error('Read unavailable'), { code: 'UNAVAILABLE' }); } });
  const worker = f.worker();
  for (let i = 0; f.store.listJobs()[0]?.stage !== 'prs' && i < 20; i++) await worker.tick();
  f.store.enrichEvent('push', { mergeEvidence: { status: 'complete', prs: [{ pullRequestId: 7 }], commits: [] } });
  await worker.tick();
  assert.equal(f.store.getEvent('push').data.mergeEvidence.error.code, 'UNAVAILABLE');
  assert.equal(f.store.getEvent('push').data.mergeEvidence.prs[0].pullRequestId, 7);
  let release;
  const waiting = fixture(t, { pushCommits() { return new Promise(resolve => { release = () => resolve({ items: [], nextCursor: null }); }); } });
  const pending = waiting.worker().tick(); waiting.store.saveRepo({ ...repo, paused: true }); release(); await pending;
  assert.equal(waiting.store.getEvent('push').data.mergeEvidence, undefined);
  waiting.store.saveRepo({ ...repo, paused: false });
  const another = waiting.worker().tick(); waiting.store.removeRepo(repo.id); release(); await another;
  assert.equal(waiting.store.getEvent('push'), undefined); assert.equal(waiting.store.listJobs().length, 0);
});

test('large association jobs finish when early negative batches expire before later batches return', async t => {
  const f = fixture(t);
  const ids = Array.from({ length: 55 }, (_, index) => (index + 20).toString(16).padStart(40, '0'));
  f.store.commitPage({ repoId: repo.id, entities: ids.map(commitId => ({ type: 'commit', id: commitId, data: { commitId, parents: [] } })) });
  f.enqueue('prs', ids);
  const batches = [];
  f.provider.queryPullRequests = async (_repo, values) => { batches.push(values); f.advance(400000); return []; };
  await drain(f.store, f.worker(), 6);
  assert.equal(f.store.listJobs().length, 0);
  assert.deepEqual(batches.map(batch => batch.length), [25, 25, 5]);
  assert.equal(new Set(batches.flat()).size, 55);
  assert.equal(f.store.getEvent('push').data.mergeEvidence.introducedCommitCount, 55);
});

test('PR completion clears an interrupted jobs association snapshot before targeted reconciliation', async t => {
  const f = fixture(t); const worker = f.worker(); await drain(f.store, worker);
  const ids = f.store.getEvent('push').data.mergeEvidence.introducedCommitIds;
  const snapshot = Object.fromEntries(ids.map(id => [id, f.store.getEntity(repo.id, 'commit-pr', id)]));
  f.enqueue('prs', ids);
  f.store.saveJob({ ...f.store.listJobs()[0], prSnapshots: snapshot });
  f.provider.queryPullRequests = async () => { f.calls.prs++; return [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: completed }]; };
  worker.reconcilePr(repo, { status: 'completed', mergeCommit: merge, targetRefName: completed.targetRefName });
  assert.equal(f.store.listJobs()[0].prSnapshots, undefined);
  await drain(f.store, worker);
  assert.equal(f.calls.prs, 2);
  assert.equal(f.store.getEvent('push').data.mergeEvidence.prs[0].pullRequestId, completed.pullRequestId);
});

test('PR completion during commit paging, range paging or hydration preserves the unfinished range and cursor', async t => {
  for (const stage of ['commits', 'ranges', 'hydrate']) {
    const f = fixture(t); const worker = f.worker(); await worker.tick();
    for (let i = 0; f.store.listJobs()[0]?.stage !== stage && i < 20; i++) await worker.tick();
    const before = f.store.listJobs()[0];
    f.provider.queryPullRequests = async () => [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: completed }];
    const result = worker.reconcilePr(repo, { status: 'completed', mergeCommit: merge, targetRefName: completed.targetRefName });
    assert.equal(result.scheduled, 1, `${stage} is found by its known interior commit`);
    const after = f.store.listJobs()[0];
    assert.equal(after.stage, stage);
    assert.deepEqual(after.cursor, before.cursor);
    assert.deepEqual(after.commitIds, before.commitIds);
    await drain(f.store, worker);
    assert.deepEqual(f.calls.pages, [{}, { skip: 1 }]);
    const evidence = f.store.getEvent('push').data.mergeEvidence;
    assert.deepEqual(evidence.introducedCommitIds, [merge, tip]);
    assert.equal(evidence.introducedCommitsComplete, true);
    assert.equal(evidence.commits[0].oldBoundaryVerified, true, 'required parent hydration was not skipped');
    assert.equal(evidence.prs[0].relationship, 'result-introduced');
  }
});

test('an empty push-commit listing still links a PR result received through an existing-object ref update', async t => {
  const queried = [];
  const f = fixture(t, {
    async pushCommits() { return { items: [], nextCursor: null }; },
    async refCommits() { return { items: [{ commitId: tip, parents: [old] }], nextCursor: null }; },
    async queryPullRequests(_repo, ids) { queried.push(...ids); return [{ commitId: tip, queryType: 'lastMergeCommit', pullRequest: { ...completed, lastMergeCommit: { commitId: tip }, completionOptions: { mergeStrategy: 'squash' } } }]; },
  });
  await drain(f.store, f.worker());
  const result = f.store.getEvent('push').data.mergeEvidence;
  assert.ok(queried.includes(tip));
  assert.deepEqual(result.introducedCommitIds, [tip]);
  assert.deepEqual(result.candidateCommitIds, [tip]);
  assert.equal(result.prs[0].relationship, 'result-introduced');
  assert.equal(result.prs[0].mergeStrategy, 'squash');
  assert.equal(result.evidenceVersion, 2);
});

test('paged ref ranges find an interior already-existing merge and resume their own cursor after restart', async t => {
  const ranges = [];
  const f = fixture(t, {
    async pushCommits() { return { items: [], nextCursor: null }; },
    async refCommits(_repo, from, to, cursor) { ranges.push({ from, to, cursor }); return cursor?.skip ? { items: [{ commitId: tip }], nextCursor: null } : { items: [{ commitId: merge }], nextCursor: { skip: 1 } }; },
    async queryPullRequests() { return [{ commitId: merge, queryType: 'lastMergeCommit', pullRequest: completed }]; },
  });
  let worker = f.worker(); await worker.tick(); await worker.tick();
  assert.equal(f.store.listJobs()[0].stage, 'ranges');
  assert.deepEqual(f.store.listJobs()[0].refCursor, { skip: 1 });
  worker = f.worker(); await drain(f.store, worker);
  assert.deepEqual(ranges, [{ from: old, to: tip, cursor: {} }, { from: old, to: tip, cursor: { skip: 1 } }]);
  const result = f.store.getEvent('push').data.mergeEvidence;
  assert.deepEqual(result.introducedCommitIds, [merge, tip]);
  assert.equal(result.commits[0].commitId, merge);
  assert.equal(result.commits[0].oldBoundaryVerified, true);
  assert.equal(result.prs[0].relationship, 'result-introduced');
  assert.equal(result.refRanges[0].complete, true);
});

test('even an empty ref range queries the moved tip but does not call a rewind newly introduced', async t => {
  const queried = [];
  const f = fixture(t, {
    async pushCommits() { return { items: [], nextCursor: null }; },
    async refCommits() { return { items: [], nextCursor: null }; },
    async queryPullRequests(_repo, ids) { queried.push(...ids); return [{ commitId: tip, queryType: 'lastMergeCommit', pullRequest: { ...completed, lastMergeCommit: { commitId: tip } } }]; },
  });
  await drain(f.store, f.worker());
  const result = f.store.getEvent('push').data.mergeEvidence;
  assert.deepEqual(queried, [tip]);
  assert.deepEqual(result.introducedCommitIds, []);
  assert.deepEqual(result.candidateCommitIds, [tip]);
  assert.equal(result.prs[0].relationship, 'constituent-related');
});

test('recent unseen enrichment is selected before old imported range reinspection', async t => {
  const f = fixture(t);
  f.store.insertEvents([{ ...push, id: 'recent', time: new Date(BASE).toISOString(), seen: false, imported: false, data: { ...push.data, pushId: 99 } }]);
  f.store.saveJob({ id: 'merge:recent', type: 'merge', repoId: repo.id, eventId: 'recent', status: 'pending', nextAt: new Date(BASE).toISOString() });
  const seen = [];
  f.provider.pushCommits = async (_repo, id) => { seen.push(id); return { items: [], nextCursor: null }; };
  await f.worker().tick();
  assert.deepEqual(seen, [99]);
});
