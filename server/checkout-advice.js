// @ts-check

import { branchName, safeAzureUrl } from '../src/events.js';

/** @typedef {import('./checkout-git.js').LinkedRepo} LinkedRepo */
/** @typedef {import('./checkout-git.js').GitRunner} GitRunner */
/** @typedef {{ id: number, source: string, target: string, sourceId?: string, targetId?: string, head?: string, result?: string, strategy?: string, url?: string }} CheckoutPull */
/** @typedef {import('../src/contract.js').PullAdvice} PullAdvice */
/** @typedef {(repo: LinkedRepo, source: string, head: string) => Promise<CheckoutPull[]>} FindCheckoutPulls */
export const isCommit = (/** @type {unknown} */ value) =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/.test(value);

/** @param {LinkedRepo} repo @param {CheckoutPull} pr */
function hasSameRepoResult(repo, pr) {
  return Boolean(
    typeof repo.azureId === 'string' &&
    repo.azureId &&
    typeof pr.sourceId === 'string' &&
    pr.sourceId.toLowerCase() === repo.azureId.toLowerCase() &&
    typeof pr.targetId === 'string' &&
    pr.targetId.toLowerCase() === repo.azureId.toLowerCase() &&
    isCommit(pr.result),
  );
}

/** @param {LinkedRepo} repo @param {CheckoutPull} pr @param {string} head */
export function isExactCheckoutPull(repo, pr, head) {
  return pr.head === head && hasSameRepoResult(repo, pr);
}

/** @param {GitRunner} run @param {string} path @param {string} ancestor @param {string} tip */
export async function ancestry(run, path, ancestor, tip) {
  if (ancestor === tip) return true;
  try {
    await run(path, ['merge-base', '--is-ancestor', ancestor, tip]);
    return true;
  } catch (error) {
    if (error instanceof Error && (('code' in error && error.code === 1) || ('status' in error && error.status === 1))) {
      return (await run(path, ['rev-parse', '--is-shallow-repository']).catch(() => '')).trim() === 'false' ? false : null;
    }
    return null;
  }
}

/**
 * @param {{ run: GitRunner, find: FindCheckoutPulls, path: string, url: string,
 *   repo: LinkedRepo, source: string, head: string, branch: string|null }} context
 * @returns {Promise<PullAdvice|undefined>}
 */
export async function adviseMissingUpstream({ run, find, path, url, repo, source, head, branch }) {
  const candidates = (await find(repo, source, head)).filter(
    pr =>
      Number.isSafeInteger(pr?.id) &&
      pr.id > 0 &&
      pr.source === source &&
      typeof pr.target === 'string' &&
      pr.target.startsWith('refs/heads/') &&
      pr.target !== source,
  );
  const sameRepo = candidates.filter(pr => hasSameRepoResult(repo, pr));
  const exact = sameRepo.filter(pr => pr.head === head);
  const eligible = exact.length ? exact : sameRepo;
  const choice = eligible[0] || candidates[0];
  if (!choice) return undefined;
  /** @type {PullAdvice} */
  const advice = {
    branch: branchName(choice.target),
    id: choice.id,
    url: safeAzureUrl(choice.url),
    strategy: choice.strategy,
    verified: false,
  };
  if (!eligible.length || new Set(eligible.map(pr => pr.target)).size !== 1 || !choice.result) return advice;
  try {
    await run(path, ['check-ref-format', choice.target]);
    const effective = (await run(path, ['ls-remote', '--get-url', '--', url])).trimEnd();
    if (effective !== url) return advice;
    const output = await run(path, ['ls-remote', '--exit-code', '--refs', '--', url, choice.target, source]);
    const refs = output
      .trimEnd()
      .split('\n')
      .map(line => line.split('\t'));
    if (refs.some(([, ref]) => ref === source)) return advice;
    const tips = refs.filter(([, ref]) => ref === choice.target);
    if (tips.length !== 1 || !isCommit(tips[0][0])) return advice;
    const tip = tips[0][0];
    let reachable = await ancestry(run, path, choice.result, tip);
    if (reachable === null) {
      // Read the target objects so an unfetched remote advance can still be verified.
      // An unqualified destination would move tracking refs through the configured refmap.
      await run(path, [
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--refmap=',
        '--',
        url,
        choice.target,
      ]);
      reachable = await ancestry(run, path, choice.result, tip);
    }
    advice.targetVerified = reachable === true;
    advice.verified = advice.targetVerified && choice.head === head;
    if (advice.targetVerified) {
      advice.receipt = { target: choice.target, result: choice.result, sourceHead: isCommit(choice.head) ? choice.head : undefined };
      advice.destination = await checkoutDestination(run, path, choice.target, branch, url);
    }
  } catch {
    /* A related PR can still be shown without verified target evidence. */
  }
  return advice;
}

/** @param {GitRunner} run @param {string} path @param {string} target @param {string|null} branch @param {string} url
 * @returns {Promise<PullAdvice['destination']>} */
async function checkoutDestination(run, path, target, branch, url) {
  if (branchName(target) === branch) return 'different-upstream';
  try {
    await run(path, ['show-ref', '--verify', '--quiet', target]);
  } catch (error) {
    if (error instanceof Error && (('code' in error && error.code === 1) || ('status' in error && error.status === 1)))
      return 'remote-only';
    return 'unknown';
  }
  const upstream = await run(path, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', '--', target]);
  const [remote, ref] = upstream.trimEnd().split('\0');
  if (!remote || ref !== target) return 'different-upstream';
  const urls = (await run(path, ['remote', 'get-url', '--all', '--', remote])).trimEnd().split('\n');
  if (urls.length !== 1 || urls[0] !== url) return 'different-upstream';
  const worktrees = await run(path, ['worktree', 'list', '--porcelain', '-z']).catch(() => null);
  if (worktrees === null) return 'unknown';
  return worktrees.split('\0').includes(`branch ${target}`) ? 'other-worktree' : 'local';
}

/** @param {{ cached: (id: string, source: string) => CheckoutPull[], lookup?: (repo: LinkedRepo, source: string) => Promise<CheckoutPull[]> }} options */
export function createCheckoutLookup({ cached, lookup }) {
  /** @type {FindCheckoutPulls} */
  return async (repo, source, head) => {
    const local = cached(repo.id, source);
    if (!lookup || local.some(pr => isExactCheckoutPull(repo, pr, head))) return local;
    try {
      const remote = await lookup(repo, source);
      return [
        ...new Map([...remote, ...local.filter(pr => !remote.some(candidate => candidate.id === pr.id))].map(pr => [pr.id, pr])).values(),
      ];
    } catch {
      return local;
    }
  };
}
