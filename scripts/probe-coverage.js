// Read-only probe of the Azure responses the coverage phases in PLAN.md depend on.
// Usage: node scripts/probe-coverage.js [--db .repo-pulse/live.sqlite] [--out docs/probe-results.md]
// Reads the watched repositories from the local database (read-only) and sends GET requests only.
// The output keeps status codes, field names, counts and latency, and never names, IDs or identities.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AZURE_DEVOPS_RESOURCE } from '../server/azure-rest.js';

const run = promisify(execFile);

/**
 * The six reads, in order. `pr` is the first active PR the list returned, or undefined.
 * @param {{ organization: string, project: string, projectId: string, azureId: string }} repo
 * @param {{ prId?: number }} [found]
 */
export function probeRequests(repo, found = {}) {
  const base = `${repo.organization.replace(/\/$/, '')}/${encodeURIComponent(repo.project)}/_apis`;
  const git = `${base}/git/repositories/${encodeURIComponent(repo.azureId)}`;
  const requests = [
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
    );
  }
  return requests.map(request => ({ ...request, method: 'GET' }));
}

/** @param {unknown} value */
const keys = value => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

/**
 * Field names and counts that answer the plan's questions. Nothing here is a name, ID or identity.
 * @param {string} name @param {any} body @param {{ azureId: string, projectId: string }} repo
 */
export function summarize(name, body, repo) {
  const items = Array.isArray(body?.value) ? body.value : [];
  const facts = { items: items.length, fields: keys(items[0]) };
  if (name === 'tag refs') {
    facts.peeled = items.filter(ref => ref.peeledObjectId).length;
  } else if (name === 'pushes with ref updates') {
    const updates = items.flatMap(push => push.refUpdates || []);
    facts.refUpdateFields = keys(updates[0]);
    facts.tagUpdates = updates.filter(update => String(update.name).startsWith('refs/tags/')).length;
    facts.branchUpdates = updates.filter(update => String(update.name).startsWith('refs/heads/')).length;
  } else if (name === 'active PRs') {
    facts.reviewerFields = keys(items.flatMap(pr => pr.reviewers || [])[0]);
    facts.withReviewers = items.filter(pr => pr.reviewers?.length).length;
    facts.fromForks = items.filter(pr => pr.forkSource).length;
    facts.timestampFields = facts.fields.filter(field => /date|time|updated/i.test(field));
  } else if (name === 'PRs from this repository') {
    const other = items.filter(pr => pr.repository?.id !== repo.azureId);
    facts.targetOtherRepository = other.length;
    facts.targetOtherProject = other.filter(pr => pr.repository?.project?.id !== repo.projectId).length;
  } else if (name === 'PR threads') {
    facts.commentFields = keys(items.flatMap(thread => thread.comments || [])[0]);
    facts.statuses = [...new Set(items.map(thread => thread.status).filter(Boolean))].sort();
    facts.system = items.filter(thread => thread.properties?.CodeReviewThreadType).length;
    facts.threadTypes = [...new Set(items.map(thread => thread.properties?.CodeReviewThreadType?.$value).filter(Boolean))].sort();
  } else if (name === 'PR policy evaluations') {
    facts.statuses = [...new Set(items.map(evaluation => evaluation.status))].sort();
    facts.configurationFields = keys(items[0]?.configuration);
    facts.policyTypes = [...new Set(items.map(evaluation => evaluation.configuration?.type?.displayName).filter(Boolean))].sort();
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

/** @param {{ name: string, url: string, method: string }} request @param {string} bearer */
async function send(request, bearer) {
  if (request.method !== 'GET') throw new Error('The probe only sends GET requests.');
  const started = performance.now();
  const response = await fetch(request.url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
  const body = response.ok ? await response.json() : undefined;
  return { status: response.status, ms: Math.round(performance.now() - started), body };
}

async function main() {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
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
    `Recorded ${new Date().toISOString().slice(0, 10)} by \`scripts/probe-coverage.js\` for ${repos.length} watched repositories. GET requests only. Repositories are numbered; no names, IDs or identities are kept.`,
    '',
    '| Repository | Read | HTTP | ms | Facts |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [index, repo] of repos.entries()) {
    const found = {};
    let requests = probeRequests(repo);
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      const { status, ms, body } = await send(request, bearer);
      if (request.name === 'active PRs')
        requests = probeRequests(repo, (found.prId = body?.value?.[0]?.pullRequestId) === undefined ? {} : found);
      const facts = body ? JSON.stringify(summarize(request.name, body, repo)) : '';
      lines.push(`| ${index + 1} | ${request.name} | ${status} | ${ms} | \`${facts.replaceAll('|', '/')}\` |`);
    }
    if (found.prId === undefined) lines.push(`| ${index + 1} | PR threads, PR policy evaluations | not read | | no active PR |`);
  }
  await writeFile(option('out', 'docs/probe-results.md'), `${lines.join('\n')}\n`);
  console.log(lines.slice(4).join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
