import test from 'node:test';
import assert from 'node:assert/strict';
import { createAzureClient, reviewOf } from '../server/azure-client.ts';
import { createNormalizer } from '../server/normalize.ts';
import { createStore } from '../server/store.ts';
import type { AzureStream, Repository } from '../src/contract.ts';
import { present, stub } from './fixtures/typed.ts';
const repo = stub<Repository>({
  id: 'local1',
  organization: 'https://dev.azure.com/example',
  project: 'Project',
  projectId: 'project1',
  azureId: 'repo1',
});
const window = { since: '2026-11-10T11:12:13Z', until: '2026-11-17T11:12:13Z' };

test('push pagination keeps fixed window and includes all refs without branch filtering', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: calls.length === 1 ? Array.from({ length: 100 }, (_, pushId) => ({ pushId })) : [{ pushId: 101 }] };
      },
    },
  });
  const first = await client.read(repo, 'pushes', window);
  assert.deepEqual(first.nextCursor, { skip: 100 });
  const second = await client.read(repo, 'pushes', { ...window, cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert(present(calls[1]).includes('$skip=100'));
  assert(present(calls[1]).includes('searchCriteria.fromDate=2026-11-10T11:12:13.000Z'));
  assert(present(calls[1]).includes('searchCriteria.includeRefUpdates=true'));
  assert(!present(calls[1]).some(value => value.startsWith('searchCriteria.refName=')));
});

test('closed PR stream uses closed time and pagination instead of creation time', async () => {
  let args: string[] | undefined;
  const client = createAzureClient({
    cli: {
      run: async input => {
        args = input;
        return { value: [] };
      },
    },
  });
  await client.read(repo, 'closedPrs', window);
  assert(args?.includes('searchCriteria.repositoryId=repo1'));
  assert(args?.includes('searchCriteria.queryTimeRangeType=closed'));
  assert(args?.includes('searchCriteria.status=all'));
  assert(args?.includes('searchCriteria.maxTime=2026-11-17T11:12:13.000Z'));
});

test('refs use continuation token and build cache isolates repositories while coalescing matching reads', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: [{ id: 1, repository: { id: 'repo1' } }], continuation_token: 'page2' };
      },
    },
  });
  const refs = await client.read(repo, 'refs', window);
  assert.deepEqual(refs.nextCursor, { token: 'page2', allRefs: true });
  await client.read(repo, 'refs', { ...window, cursor: refs.nextCursor });
  assert(present(calls[1]).includes('continuationToken=page2'));
  const [a, b] = await Promise.all([
    client.read(repo, 'builds', window),
    client.read({ ...repo, azureId: 'repo2' }, 'builds', { ...window, since: '2026-11-10T11:13:13Z' }),
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(a, b);
  assert(present(calls[2]).includes('repositoryId=repo1'));
  assert(present(calls[3]).includes('repositoryId=repo2'));
  assert(present(calls[2]).includes('repositoryType=TfsGit'));
  await client.read(repo, 'builds', window);
  assert.equal(calls.length, 4);
  assert.equal(a.nextCursor?.from, '2026-11-10T11:10:00.000Z');
  const active = await client.read(repo, 'activeBuilds', window);
  const [build] = active.items;
  assert.equal(build && 'id' in build && build.id, 1);
  assert(!present(calls.at(-1)).some(value => value.startsWith('minTime=')));
  assert(present(calls.at(-1)).includes('repositoryId=repo1'));
  // Numeric ids still reach the query as before; the type says string, so the number needs a cast.
  const numericIds = [123] as unknown as string[];
  assert.deepEqual(await client.buildsById(repo, numericIds), {
    items: [{ id: 1, repository: { id: 'repo1' } }],
    nextCursor: { token: 'page2' },
  });
  assert(present(calls.at(-1)).includes('buildIds=123'));
});

test('malformed responses fail rather than becoming healthy empty activity', async () => {
  const client = createAzureClient({ cli: { run: async () => ({ error: 'bad' }) } });
  await assert.rejects(client.read(repo, 'refs', window), { code: 'INVALID_RESPONSE' });
});

test('resolution strips credentials and connection check never claims CLI account is effective identity', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'devops') return { value: [] };
        return {
          id: 'abc',
          name: 'Repo',
          project: { id: 'p', name: 'Project' },
          remoteUrl: 'https://secret@dev.azure.com/example/Project/_git/Repo',
        };
      },
    },
  });
  const resolved = await client.resolveRepository('https://example@dev.azure.com/example/Project/_git/Repo');
  assert.equal(resolved.webUrl, 'https://dev.azure.com/example/Project/_git/Repo');
  assert(!JSON.stringify(resolved).includes('secret'));
  const before = calls.length;
  for (const input of [
    { organization: repo.organization, project: '@notes.txt', name: 'Repo' },
    { organization: repo.organization, project: 'Project', name: '@notes.txt' },
  ])
    await assert.rejects(client.resolveRepository(input), /valid Azure repository/);
  assert.equal(calls.length, before);
  const connection = await client.checkConnection(repo.organization);
  assert.equal(connection.available, true);
  assert.equal(connection.identityVerified, false);
  assert.equal(connection.identity, null);
  assert(!calls.some(args => args.includes('get-access-token')));
});

test('active PR reads are explicitly repo-scoped and exact PR reconciliation uses typed CLI', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return args[0] === 'repos' ? { pullRequestId: 123, repository: { id: 'repo1' } } : { value: [] };
      },
    },
  });
  await client.read(repo, 'prs', window);
  assert(present(calls[0]).includes('searchCriteria.repositoryId=repo1'));
  assert.equal((await client.pullRequest(repo, 123)).pullRequestId, 123);
  assert.deepEqual(present(calls[1]).slice(0, 3), ['repos', 'pr', 'show']);
  const foreign = createAzureClient({ cli: { run: async () => ({ pullRequestId: 123, repository: { id: 'different' } }) } });
  await assert.rejects(foreign.pullRequest(repo, 123), { code: 'WRONG_REPOSITORY' });
  // A readable identity that names another pull request is a wrong answer, not an unreadable record.
  const otherId = createAzureClient({ cli: { run: async () => ({ pullRequestId: 124, repository: { id: 'repo1' } }) } });
  await assert.rejects(otherId.pullRequest(repo, 123), { code: 'INVALID_RESPONSE' });
  // Azure GUIDs differ in case between APIs, as elsewhere in the app.
  const upper = createAzureClient({ cli: { run: async () => ({ pullRequestId: 123, repository: { id: 'REPO1' } }) } });
  assert.equal((await upper.pullRequest(repo, 123)).pullRequestId, 123);
  // A malformed display field does not make the pull request unreadable; it is passed on as Azure sent it.
  const oddLink = createAzureClient({ cli: { run: async () => ({ pullRequestId: 123, repository: { id: 'repo1' }, _links: 'link' }) } });
  assert.deepEqual(await oddLink.pullRequest(repo, 123), { pullRequestId: 123, repository: { id: 'repo1' }, _links: 'link' });
  // An identity that cannot be read is skipped and counted like any unreadable record.
  for (const [payload, field] of [
    [{ repository: { id: 'repo1' } }, 'pullRequestId'],
    [{ pullRequestId: [123], repository: { id: 'repo1' } }, 'pullRequestId'],
    [{ pullRequestId: '123', repository: { id: 'repo1' } }, 'pullRequestId'],
    [{ pullRequestId: '124', repository: { id: 'repo1' } }, 'pullRequestId'],
    [{ pullRequestId: 123 }, 'repository.id'],
    [{ pullRequestId: 123, repository: { id: 7 } }, 'repository.id'],
    [{ pullRequestId: 123, repository: { id: { id: 'repo1' } } }, 'repository.id'],
    [{ pullRequestId: 123, repository: { id: '  ' } }, 'repository.id'],
  ] satisfies [object, string][]) {
    const odd = createAzureClient({ cli: { run: async () => payload } });
    await assert.rejects(odd.pullRequest(repo, 123), { code: 'UNREADABLE_RECORD', field }, JSON.stringify(payload));
  }
  // An answer that is not an object at all is not a pull request, so it is a wrong answer as well.
  for (const payload of [null, 'pull request 123', [{ pullRequestId: 123, repository: { id: 'repo1' } }], 123]) {
    const notObject = createAzureClient({ cli: { run: async () => payload } });
    await assert.rejects(notObject.pullRequest(repo, 123), { code: 'INVALID_RESPONSE' }, JSON.stringify(payload));
  }
});

test('connection detection reuses local CLI sign-in without acquiring credentials or requiring setup', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return { user: { name: 'existing@example.test' }, tenantId: 'tenant', accessToken: 'must-not-return' };
        throw new Error('Unexpected remote operation');
      },
    },
  });
  const status = await client.checkConnection();
  assert.equal(status.available, true);
  assert.equal(status.signedIn, true);
  assert.deepEqual(status.account, { name: 'existing@example.test' });
  assert.equal(status.identityVerified, false);
  assert.equal(JSON.stringify(status).includes('must-not-return'), false);
  assert.deepEqual(
    calls.map(args => args.slice(0, 2).join(' ')),
    ['version', 'extension show', 'account show'],
  );
  await client.checkConnection();
  assert.equal(calls.length, 3, 'local detection is cached');
});

test('a missing account-show context does not reject existing DevOps CLI credentials', async () => {
  const client = createAzureClient({
    cli: {
      async run(args) {
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') throw Object.assign(new Error('No cached Entra account'), { code: 'AUTH_REQUIRED' });
        return { value: [] };
      },
    },
  });
  const status = await client.checkConnection(repo.organization);
  assert.equal(status.available, true);
  assert.equal(status.signedIn, false);
  assert.equal(status.capabilities?.organizationRead, true);
  assert.match(status.message, /Existing Azure CLI access works/);
});

test('dropped commits read one page from the old tip that the new tip does not reach', async () => {
  const old = 'a'.repeat(40),
    tip = 'b'.repeat(40),
    calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: Array.from({ length: 100 }, () => ({ commitId: old })) };
      },
    },
  });
  const page = await client.droppedCommits(repo, old, tip);
  assert.equal(page.items.length, 100);
  assert.deepEqual(page.nextCursor, { skip: 100 }, 'a full page says more were dropped');
  assert.equal(calls.length, 1);
  const args = present(calls[0]);
  assert(args?.includes(`searchCriteria.compareVersion.version=${old}`));
  assert(args?.includes(`searchCriteria.itemVersion.version=${tip}`));
  assert(args?.includes('searchCriteria.compareVersion.versionType=commit'));
  assert(args?.includes('searchCriteria.itemVersion.versionType=commit'));
  assert(args?.includes('searchCriteria.$skip=0'));
  assert(!args.some(arg => /fromCommitId|toCommitId|fromDate|toDate|showOldestCommitsFirst/.test(arg)));
});

test('ref creation/deletion/equal tips cannot scan historical ancestry and malformed ranges fail closed', async () => {
  const old = 'a'.repeat(40),
    tip = 'b'.repeat(40),
    zero = '0'.repeat(40);
  let calls = 0;
  const client = createAzureClient({
    cli: {
      run: async () => {
        calls++;
        return { value: [{ commitId: 'not-a-sha' }] };
      },
    },
  });
  for (const [from, to] of [
    [zero, tip],
    [old, zero],
    [old, old],
  ] satisfies [string, string][])
    assert.deepEqual(await client.droppedCommits(repo, from, to), { items: [], nextCursor: null });
  assert.equal(calls, 0);
  await assert.rejects(client.droppedCommits(repo, 'refs/heads/main', tip), { code: 'INVALID_QUERY' });
  await assert.rejects(client.droppedCommits(repo, old, tip), { code: 'INVALID_RESPONSE' });
});

test('checkout PR lookup is bounded and accepts completed PRs in the same source and target repository only', async () => {
  const calls: string[][] = [];
  const sourceRefName = 'refs/heads/feature/test';
  const pr = (id: number) => ({
    pullRequestId: id,
    status: 'completed',
    repository: { id: repo.azureId },
    sourceRefName,
    targetRefName: 'refs/heads/release',
    lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
    lastMergeCommit: { commitId: 'b'.repeat(40) },
    completionOptions: { mergeStrategy: 'rebase' },
  });
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return {
          value: [
            pr(1),
            { ...pr(2), forkSource: { repository: { id: 'fork' } } },
            { ...pr(3), repository: { id: 'other' } },
            { ...pr(4), status: 'active' },
          ],
        };
      },
    },
  });
  const pull = present((await client.completedCheckoutPulls(repo, sourceRefName))[0]);
  assert.ok(!('unreadable' in pull));
  assert.equal(pull.id, 1);
  assert.equal(pull.strategy, 'rebase');
  assert.equal((await client.completedCheckoutPulls(repo, sourceRefName)).length, 1);
  assert.equal(calls.length, 1);
  assert.ok(present(calls[0]).includes('$top=20'));
  assert.ok(present(calls[0]).includes('searchCriteria.sourceRepositoryId=repo1'));
  assert.ok(present(calls[0]).includes('searchCriteria.repositoryId=repo1'));
  assert.ok(present(calls[0]).includes('searchCriteria.sourceRefName=' + sourceRefName));
});

test('repository connection check preserves local CLI state when the scoped read fails', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    now: () => 0,
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return {};
        throw Object.assign(new Error('Repository read refused'), { code: 'FORBIDDEN' });
      },
    },
  });
  const status = await client.checkConnection(undefined, repo);
  assert.equal(status.available, true);
  assert.equal(status.version, '2.93.0');
  assert.deepEqual(status.access, {
    status: 'failed',
    checkedAt: '1970-01-01T00:00:00.000Z',
    code: 'FORBIDDEN',
    message: 'Repository read refused',
  });
  assert.deepEqual(calls.at(-1), [
    'repos',
    'show',
    '--repository',
    repo.azureId,
    '--project',
    repo.projectId || repo.project,
    '--organization',
    repo.organization,
    '--detect',
    'false',
  ]);
});

test('a repository connection check also proves the REST activity read', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    now: () => 0,
    cli: {
      async run(args) {
        calls.push(args);
        if (args[0] === 'version') return { 'azure-cli': '2.93.0' };
        if (args[0] === 'extension') return { version: '1.0.2' };
        if (args[0] === 'account') return {};
        if (args[0] === 'repos') return { id: repo.azureId };
        throw Object.assign(new Error('Azure CLI sign-in is unavailable or expired.'), { code: 'AUTH_REQUIRED' });
      },
    },
  });
  const status = await client.checkConnection(undefined, repo);
  assert.equal(status.access?.status, 'failed');
  assert.equal(status.access?.code, 'AUTH_REQUIRED');
  const read = present(calls.at(-1));
  assert.deepEqual(
    [read[0], read[1], read[read.indexOf('--resource') + 1], read[read.indexOf('--http-method') + 1]],
    ['devops', 'invoke', 'refs', 'GET'],
  );
});

test('PR review data counts people’s threads only and keeps each enabled policy result', () => {
  const thread = (status: string | undefined, extra = {}) => ({ status, comments: [{ commentType: 'text' }], ...extra });
  const review = reviewOf(
    [
      thread('active'),
      thread('pending'),
      thread('fixed'),
      thread('closed'),
      thread('active', { isDeleted: true }),
      thread(undefined, { properties: { CodeReviewThreadType: { $value: 'VoteUpdate' } } }),
    ],
    [
      { status: 'approved', configuration: { isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } },
      { status: 'rejected', configuration: { isEnabled: true, isBlocking: false, type: { displayName: 'Build' } } },
      { status: 'approved', configuration: { isEnabled: false, type: { displayName: 'Disabled policy' } } },
    ],
  );
  assert.deepEqual(review, {
    threads: { open: 2, resolved: 2 },
    policies: [
      { name: 'Minimum number of reviewers', status: 'approved', blocking: true },
      { name: 'Build', status: 'rejected', blocking: false },
    ],
  });
  assert.throws(() => reviewOf(undefined, []), { code: 'INVALID_RESPONSE' });
});

test('refs restart a snapshot saved by the branch-only query and ask policies for not-applicable results', async () => {
  const calls: string[][] = [];
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return { value: [] };
      },
    },
  });
  const restarted = await client.read(repo, 'refs', { cursor: { token: 'from-heads-only' } });
  assert(!present(calls[0]).some(arg => arg.startsWith('continuationToken=')));
  assert.equal(restarted.restarted, true);
  await client.read(repo, 'refs', { cursor: { token: 'all', allRefs: true } });
  assert(present(calls[1]).includes('continuationToken=all'));
  await client.prReview(repo, 4);
  assert(present(calls.at(-1)).includes('includeNotApplicable=true'));
});

test('a single commit read returns its parents and the push that brought it, and fails closed on bad input', async () => {
  const id = 'a'.repeat(40),
    parent = 'b'.repeat(40);
  const calls: string[][] = [];
  let body: object = { commitId: id, parents: [parent.toUpperCase()], push: { pushId: 41 }, comment: 'not kept' };
  const client = createAzureClient({
    cli: {
      run: async args => {
        calls.push(args);
        return body;
      },
    },
  });
  assert.deepEqual(await client.commit(repo, id.toUpperCase()), { parents: [parent], pushId: 41 });
  assert(present(calls[0]).includes(`commitId=${id}`));
  assert(present(calls[0]).includes('changeCount=0'));
  body = { commitId: id, parents: [] };
  assert.deepEqual(await client.commit(repo, id), { parents: [], pushId: null });
  await assert.rejects(client.commit(repo, 'main'), { code: 'INVALID_QUERY' });
  body = { commitId: id, parents: ['not-a-sha'] };
  await assert.rejects(client.commit(repo, id), { code: 'INVALID_RESPONSE' });
  body = { commitId: id };
  await assert.rejects(client.commit(repo, id), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 4);
});

const readable: Record<AzureStream, Record<string, unknown>> = {
  pushes: { pushId: 1, date: '2026-11-17T10:00:00Z', refUpdates: [{ name: 'refs/heads/main', oldObjectId: 'a', newObjectId: 'b' }] },
  refs: { name: 'refs/heads/main', objectId: 'a' },
  prs: { pullRequestId: 1, status: 'active', reviewers: [{ id: 'r', vote: 10 }] },
  closedPrs: { pullRequestId: 2, status: 'completed', lastMergeCommit: { commitId: 'c' } },
  builds: { id: 1, repository: { id: 'repo1' }, status: 'completed' },
  activeBuilds: { id: 2, repository: { id: 'repo1' }, status: 'inProgress', requestedFor: { displayName: 'A' } },
};
const malformed: [AzureStream, Record<string, unknown>, string][] = [
  ['pushes', { ...readable.pushes, refUpdates: { name: 'refs/heads/main' } }, 'refUpdates'],
  ['refs', { ...readable.refs, objectId: 7 }, 'objectId'],
  ['prs', { ...readable.prs, reviewers: [{ id: 'r', vote: '10' }] }, 'reviewers.vote'],
  ['closedPrs', { ...readable.closedPrs, pullRequestId: undefined }, 'pullRequestId'],
  ['builds', { ...readable.builds, repository: { id: 7 } }, 'repository.id'],
  ['activeBuilds', { ...readable.activeBuilds, id: '2' }, 'id'],
];
for (const [stream, record, field] of malformed)
  test(`a ${stream} page keeps its readable records and counts one with a malformed ${field}`, async () => {
    const client = createAzureClient({ cli: { run: async () => ({ value: [readable[stream], record] }) } });
    const page = await client.read(repo, stream, window);
    assert.deepEqual(page.items, [readable[stream]]);
    assert.deepEqual(page.unreadable, { count: 1, fields: [field] });
  });

/**
 * For each stream, fields read for identity or meaning and display fields the code shows with a fallback. A malformed
 * display field keeps the record as Azure sent it, and the event shows what origin/main 844c7b6 shows, with the same
 * IDs; where main put a value that is not text into an event's actor or title, the event holds its text. A malformed
 * required field still makes the record unreadable. The refs stream has no display field.
 */
const watched = { ...repo, webUrl: 'https://dev.azure.com/example/Project/_git/repo' };
const pushUrl = `${watched.webUrl}/pushes?pushId=1`;
const fieldRules: { stream: AzureStream; patch: Record<string, unknown>; shown?: Record<string, unknown>; unreadable?: string }[] = [
  { stream: 'pushes', patch: { _links: { web: 'https://dev.azure.com/x' } }, shown: { url: pushUrl } },
  { stream: 'pushes', patch: { _links: 'link' }, shown: { url: pushUrl } },
  { stream: 'pushes', patch: { pushedBy: 'A' }, shown: { title: 'Unknown pushed to main', actor: 'Unknown' } },
  { stream: 'pushes', patch: { pushedBy: { displayName: 7, name: 'a' } }, shown: { title: '7 pushed to main', actor: '7' } },
  { stream: 'pushes', patch: { pushId: '1' }, unreadable: 'pushId' },
  { stream: 'pushes', patch: { date: 7 }, unreadable: 'date' },
  { stream: 'pushes', patch: { commits: {} }, unreadable: 'commits' },
  { stream: 'pushes', patch: { refUpdates: [{ name: 'refs/tags/v1', oldObjectId: 7 }] }, unreadable: 'refUpdates.oldObjectId' },
  { stream: 'refs', patch: { name: 7 }, unreadable: 'name' },
  { stream: 'refs', patch: { peeledObjectId: 7 }, unreadable: 'peeledObjectId' },
  { stream: 'prs', patch: { title: 7 }, shown: { id: 'local1:pr:1:1:072e2b627223a969a109c058', title: 'PR 1 · 7' } },
  { stream: 'prs', patch: { createdBy: ['A'] }, shown: { actor: 'Unknown' } },
  {
    stream: 'prs',
    patch: { reviewers: [{ id: 'r', vote: 10, displayName: 7 }] },
    shown: { 'data.reviewers': [{ id: 'r', name: 7, vote: 10, required: false }] },
  },
  { stream: 'prs', patch: { _links: { web: 7 } }, shown: { url: `${watched.webUrl}/pullrequest/1` } },
  { stream: 'prs', patch: { status: 7 }, unreadable: 'status' },
  { stream: 'prs', patch: { isDraft: 'yes' }, unreadable: 'isDraft' },
  { stream: 'prs', patch: { creationDate: 7 }, unreadable: 'creationDate' },
  { stream: 'prs', patch: { reviewers: [{ id: 7, vote: 10 }] }, unreadable: 'reviewers.id' },
  { stream: 'prs', patch: { forkSource: { repository: { id: 'f', name: 7 } } }, unreadable: 'forkSource.repository.name' },
  { stream: 'closedPrs', patch: { closedBy: { displayName: 7 } }, shown: { 'data.closedBy': 7 } },
  { stream: 'closedPrs', patch: { lastMergeCommit: { commitId: 7 } }, unreadable: 'lastMergeCommit.commitId' },
  { stream: 'closedPrs', patch: { completionOptions: { mergeStrategy: 7 } }, unreadable: 'completionOptions.mergeStrategy' },
  { stream: 'builds', patch: { definition: { name: 7, id: 3 } }, shown: { title: '7', 'data.definition': { name: 7, id: 3 } } },
  { stream: 'builds', patch: { definition: 'CI' }, shown: { title: 'Pipeline', 'data.definition': 'CI' } },
  { stream: 'builds', patch: { reason: 7 }, shown: { 'data.reason': 7 } },
  { stream: 'builds', patch: { requestedBy: 7 }, shown: { actor: 'Unknown' } },
  { stream: 'builds', patch: { result: 7 }, unreadable: 'result' },
  { stream: 'builds', patch: { finishTime: 7 }, unreadable: 'finishTime' },
  { stream: 'activeBuilds', patch: { requestedFor: { displayName: ['A'] } }, shown: { actor: 'A' } },
  {
    stream: 'activeBuilds',
    patch: { _links: { web: [] } },
    shown: { url: `${watched.organization}/Project/_build/results?buildId=2` },
  },
  { stream: 'activeBuilds', patch: { sourceBranch: 7 }, unreadable: 'sourceBranch' },
];
for (const { stream, patch, shown, unreadable } of fieldRules)
  test(`a ${stream} record with ${JSON.stringify(patch)} is ${shown ? 'kept and shown as on main' : `unreadable for ${unreadable}`}`, async () => {
    const record = { ...readable[stream], ...patch };
    const page = await createAzureClient({ cli: { run: async () => ({ value: [record] }) } }).read(repo, stream, window);
    if (!shown) {
      assert.deepEqual(page.items, []);
      assert.deepEqual(page.unreadable, { count: 1, fields: [unreadable] });
      return;
    }
    assert.deepEqual(page.items, [record], 'as Azure sent it');
    assert.equal(page.unreadable, undefined);
    const store = createStore();
    try {
      const event = present(createNormalizer({ store }).normalize(watched, stream, page.items, { initialized: true }).events[0]);
      const data = Object.entries(event.data ?? {}).map(([key, value]) => [`data.${key}`, value]);
      const seen: Record<string, unknown> = {
        id: event.id,
        title: event.title,
        actor: event.actor,
        url: event.url,
        ...Object.fromEntries(data),
      };
      for (const [key, value] of Object.entries(shown)) assert.deepEqual(seen[key], value, key);
    } finally {
      store.close();
    }
  });

test('a ref with an empty name or objectId is unreadable', async () => {
  const value = [
    { name: 'refs/heads/main', objectId: 'a' },
    { name: '', objectId: 'b' },
    { name: 'refs/heads/b', objectId: ' ' },
  ];
  const page = await createAzureClient({ cli: { run: async () => ({ value }) } }).read(repo, 'refs', window);
  assert.deepEqual(page.items, [value[0]]);
  assert.deepEqual(page.unreadable, { count: 2, fields: ['name', 'objectId'] });
});

test('a skip-paged read with an unreadable record on a full page still pages on', async () => {
  const value = Array.from({ length: 100 }, (_, index) => ({ pushId: index }));
  const page = await createAzureClient({ cli: { run: async () => ({ value }) } }).read(repo, 'pushes', window);
  assert.equal(page.items.length, 99);
  assert.deepEqual(page.unreadable, { count: 1, fields: ['pushId'] });
  assert.deepEqual(page.nextCursor, { skip: 100 });
});
