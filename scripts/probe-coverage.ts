// Read-only probe of the Azure responses the coverage phases in PLAN.md depend on.
// Usage: node scripts/probe-coverage.ts [--db .repo-pulse/live.sqlite] [--out docs/probe-results.md]
// Reads the watched repositories from the local database (read-only) and sends GET requests only.
// The output keeps status codes, field names, counts and latency, and never names, IDs or identities.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AZURE_DEVOPS_RESOURCE } from '../server/azure-rest.ts';
import { normalizeOrganization } from '../server/repositories.ts';
import { isRecord, recordsOf } from '../server/azure-records.ts';

const run = promisify(execFile);

type Found = { prId?: number; sourceCommit?: string; targetCommit?: string; creations?: { pushId: number; tip: string }[] };
const SHA = /^[0-9a-f]{40}$/i;
/** The value at a path of object fields, or undefined where one is missing or not an object. */
const field = (value: unknown, ...path: string[]): unknown => path.reduce((at, key) => (isRecord(at) ? at[key] : undefined), value);
/** A response's `value` list, or an empty list when it has none. */
const valueList = (body: unknown): unknown[] => {
  const list = field(body, 'value');
  return Array.isArray(list) ? list : [];
};

/**
 * The reads, in order. The per-PR reads use the first active PR the list returned; the fork evidence reads use the
 * branch creation pushes in the push list.
 */
export function probeRequests(repo: { organization: string; project: string; projectId: string; azureId: string }, found: Found = {}) {
  // The token goes only to an Azure DevOps organization URL the app itself would accept.
  const base = `${normalizeOrganization(repo.organization)}/${encodeURIComponent(repo.project)}/_apis`;
  const git = `${base}/git/repositories/${encodeURIComponent(repo.azureId)}`;
  const requests: { name: string; url: string; tip?: string }[] = [
    { name: 'tag refs', url: `${git}/refs?filter=tags/&peelTags=true&$top=100&api-version=7.1` },
    { name: 'pushes with ref updates', url: `${git}/pushes?searchCriteria.includeRefUpdates=true&$top=100&api-version=7.1` },
    { name: 'active PRs', url: `${git}/pullrequests?searchCriteria.status=active&$top=20&api-version=7.1` },
    {
      name: 'PRs from this repository',
      url: `${base}/git/pullrequests?searchCriteria.sourceRepositoryId=${encodeURIComponent(repo.azureId)}&searchCriteria.status=all&$top=50&api-version=7.1`,
    },
  ];
  if (found.prId !== undefined) {
    requests.push(
      { name: 'PR threads', url: `${git}/pullrequests/${found.prId}/threads?api-version=7.1` },
      {
        name: 'PR policy evaluations',
        url: `${base}/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${repo.projectId}/${found.prId}`)}&api-version=7.1-preview.1`,
      },
      { name: 'PR iterations', url: `${git}/pullrequests/${found.prId}/iterations?api-version=7.1` },
    );
    if (SHA.test(found.sourceCommit ?? '') && SHA.test(found.targetCommit ?? ''))
      requests.push({
        name: 'PR merge bases',
        url: `${git}/commits/${found.sourceCommit}/mergebases?otherCommitId=${found.targetCommit}&api-version=7.1`,
      });
  }
  for (const { pushId, tip } of found.creations ?? []) {
    if (!Number.isSafeInteger(pushId) || !SHA.test(tip)) continue;
    requests.push(
      { name: 'creation push commits', url: `${git}/commits?pushId=${pushId}&top=100&api-version=7.1`, tip },
      { name: 'created commit', url: `${git}/commits/${tip}?changeCount=0&api-version=7.1`, tip },
    );
  }
  return requests.map(request => ({ ...request, method: 'GET' }));
}

/**
 * Pushes that created a branch, newest first, at most three: the push and the revision the branch was created at.
 */
export function creationPushes(body: any): { pushId: number; tip: string }[] {
  return recordsOf('pushes', valueList(body))
    .flatMap(push =>
      (push.refUpdates || [])
        .flatMap(({ name, oldObjectId, newObjectId: tip }) =>
          String(name).startsWith('refs/heads/') && /^0+$/.test(oldObjectId ?? '') && typeof tip === 'string' && SHA.test(tip)
            ? [{ pushId: push.pushId, tip }]
            : [],
        )
        .slice(0, 1),
    )
    .slice(0, 3);
}

// Only Azure's own names for built-in policy and thread types are reported; anything else, such as a
// build policy named after a pipeline, is counted as "other" so no organization-chosen name is written.
const BUILT_IN_POLICIES = new Set([
  'Minimum number of reviewers',
  'Comment requirements',
  'Required reviewers',
  'Work item linking',
  'Require a merge strategy',
  'Build',
  'Status',
  'File size restriction',
  'File name restriction',
  'Path Length restriction',
  'Reserved names restriction',
  'Commit author email validation',
  'Git repository settings',
]);
const THREAD_TYPES = new Set([
  'VoteUpdate',
  'ResetMultipleVotes',
  'ResetAllVotes',
  'ReviewersUpdate',
  'RefUpdate',
  'SourceBranchChanged',
  'StatusUpdate',
  'MergeAttempt',
  'IsDraftUpdate',
  'PolicyStatusUpdate',
]);
const THREAD_STATUSES = new Set(['active', 'pending', 'fixed', 'wontFix', 'closed', 'byDesign', 'unknown']);
const ITERATION_REASONS = new Set(['create', 'push', 'forcePush', 'rebase', 'retarget', 'resolveConflicts', 'unknown']);
const POLICY_STATUSES = new Set(['queued', 'running', 'approved', 'rejected', 'notApplicable', 'broken']);
const named = (values: unknown[], known: Set<string>) =>
  [...new Set(values.filter(Boolean).map(value => (known.has(String(value)) ? String(value) : 'other')))].sort();

const keys = (value: unknown) => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

/**
 * Field names and counts that answer the plan's questions. Nothing here is a name, ID or identity.
 * @param [context] the revision a creation push created the branch at
 */
export function summarize(name: string, body: any, repo: { azureId: string; projectId: string }, context: { tip?: string } = {}) {
  if (name === 'created commit')
    return { fields: keys(body), parents: Array.isArray(body?.parents) ? body.parents.length : null, pushFields: keys(body?.push) };
  const items = valueList(body);
  const facts: { items: number; fields: string[]; [fact: string]: unknown } = { items: items.length, fields: keys(items[0]) };
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  if (name === 'tag refs') {
    facts.peeled = items.filter(ref => field(ref, 'peeledObjectId')).length;
  } else if (name === 'pushes with ref updates') {
    const updates = items.flatMap(push => field(push, 'refUpdates') || []);
    facts.tagUpdateFields = keys(updates.find(update => String(field(update, 'name')).startsWith('refs/tags/')));
    facts.tagUpdates = updates.filter(update => String(field(update, 'name')).startsWith('refs/tags/')).length;
    facts.branchUpdates = updates.filter(update => String(field(update, 'name')).startsWith('refs/heads/')).length;
  } else if (name === 'active PRs') {
    facts.reviewerFields = keys(items.flatMap(pr => field(pr, 'reviewers') || [])[0]);
    facts.withReviewers = items.filter(pr => list(field(pr, 'reviewers')).length).length;
    facts.fromForks = items.filter(pr => field(pr, 'forkSource')).length;
    facts.timestampFields = facts.fields.filter(key => /date|time|updated/i.test(key));
  } else if (name === 'PRs from this repository') {
    const other = items.filter(pr => field(pr, 'repository', 'id') !== repo.azureId);
    facts.targetOtherRepository = other.length;
    facts.targetOtherProject = other.filter(pr => field(pr, 'repository', 'project', 'id') !== repo.projectId).length;
  } else if (name === 'PR threads') {
    facts.commentFields = keys(items.flatMap(thread => field(thread, 'comments') || [])[0]);
    facts.statuses = named(
      items.map(thread => field(thread, 'status')),
      THREAD_STATUSES,
    );
    facts.withThreadType = items.filter(thread => field(thread, 'properties', 'CodeReviewThreadType')).length;
    facts.threadTypes = named(
      items.map(thread => field(thread, 'properties', 'CodeReviewThreadType', '$value')),
      THREAD_TYPES,
    );
  } else if (name === 'creation push commits') {
    const ids = new Set(items.map(commit => field(commit, 'commitId')));
    facts.withParents = items.filter(commit => Array.isArray(field(commit, 'parents'))).length;
    facts.outsideParents = new Set(items.flatMap(commit => field(commit, 'parents') || []).filter(parent => !ids.has(parent))).size;
    facts.tipFirst = items.length ? field(items[0], 'commitId') === context.tip : null;
    facts.newestFirst =
      items.length > 1 ? items.slice(1).every((commit, i) => list(field(items[i], 'parents')).includes(field(commit, 'commitId'))) : null;
  } else if (name === 'PR iterations') {
    facts.reasons = named(
      items.map(iteration => field(iteration, 'reason')),
      ITERATION_REASONS,
    );
    facts.withCommonRefCommit = items.filter(iteration => field(iteration, 'commonRefCommit', 'commitId')).length;
    facts.retargetFields = keys(items.find(iteration => field(iteration, 'reason') === 'retarget'));
  } else if (name === 'PR policy evaluations') {
    facts.statuses = named(
      items.map(evaluation => field(evaluation, 'status')),
      POLICY_STATUSES,
    );
    facts.configurationFields = keys(field(items[0], 'configuration'));
    facts.policyTypes = named(
      items.map(evaluation => field(evaluation, 'configuration', 'type', 'displayName')),
      BUILT_IN_POLICIES,
    );
  }
  return facts;
}

async function token() {
  const { stdout } = await run('az', [
    'account',
    'get-access-token',
    '--resource',
    AZURE_DEVOPS_RESOURCE,
    '--query',
    'accessToken',
    '-o',
    'tsv',
  ]);
  return stdout.trim();
}

async function send(request: { name: string; url: string; method: string }, bearer: string) {
  if (request.method !== 'GET') throw new Error('The probe only sends GET requests.');
  const started = performance.now();
  // A refused token must come back as its HTTP status, not as a redirect to a sign-in page.
  const response = await fetch(request.url, {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
  });
  const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
  return { status: response.status, ms: Math.round(performance.now() - started), body };
}

async function main() {
  const option = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    // A missing value already threw where the option is used; this names the option instead.
    if (value === undefined) throw new Error(`--${name} needs a value.`);
    return value;
  };
  const db = new DatabaseSync(option('db', '.repo-pulse/live.sqlite'), { readOnly: true });
  const repos = db
    .prepare('SELECT data FROM repositories')
    .all()
    .map(row => JSON.parse(String(row.data)))
    .filter(repo => !repo.disabled);
  db.close();
  const bearer = await token();
  const lines = [
    '# Coverage probe results',
    '',
    `Recorded ${new Date().toISOString().slice(0, 10)} by \`scripts/probe-coverage.ts\` for ${repos.length} watched repositories. GET requests only. Repositories are numbered; no names, IDs or identities are kept.`,
    '',
    '| Repository | Read | HTTP | ms | Facts |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [index, repo] of repos.entries()) {
    const found: Found = {};
    let requests = probeRequests(repo);
    // The list grows after the first reads, so this reads it by index rather than iterating a copy.
    for (let i = 0; ; i++) {
      const request = requests[i];
      if (!request) break;
      const { status, ms, body } = await send(request, bearer);
      if (request.name === 'pushes with ref updates') found.creations = creationPushes(body);
      if (request.name === 'active PRs') {
        const [pr] = valueList(body);
        Object.assign(found, {
          prId: field(pr, 'pullRequestId'),
          sourceCommit: field(pr, 'lastMergeSourceCommit', 'commitId'),
          targetCommit: field(pr, 'lastMergeTargetCommit', 'commitId'),
        });
      }
      if (request.name === 'pushes with ref updates' || request.name === 'active PRs') requests = probeRequests(repo, found);
      const facts = body ? JSON.stringify(summarize(request.name, body, repo, request)) : '';
      lines.push(`| ${index + 1} | ${request.name} | ${status} | ${ms} | \`${facts.replaceAll('|', '/')}\` |`);
    }
    if (found.prId === undefined)
      lines.push(`| ${index + 1} | PR threads, PR policy evaluations, PR iterations | not read | | no active PR |`);
    if (!found.creations?.length) lines.push(`| ${index + 1} | creation push commits | not read | | no branch creation in the push list |`);
  }
  await writeFile(option('out', 'docs/probe-results.md'), `${lines.join('\n')}\n`);
  console.log(lines.slice(4).join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Errors from az or a response can carry account, tenant or repository details, so only a fixed message is printed.
  await main().catch(() => {
    console.error('The coverage probe failed. Check the Azure CLI sign-in and the database path, then run it again.');
    process.exitCode = 1;
  });
}
