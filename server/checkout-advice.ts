import { branchName, safeAzureUrl } from '../src/events.ts';
import type { GitRunner } from './checkout-git.ts';
import type { CheckoutPull, UnreadableCheckoutPull } from './azure-client.ts';
import type { PullAdvice, Repository as LinkedRepo } from '../src/contract.d.ts';

export type FindCheckoutPulls = (repo: LinkedRepo, source: string, head: string) => Promise<(CheckoutPull | UnreadableCheckoutPull)[]>;
const readable = (pr: CheckoutPull | UnreadableCheckoutPull): pr is CheckoutPull => !('unreadable' in pr);
export const isCommit = (value: unknown) =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/.test(value);

function hasSameRepoResult(repo: LinkedRepo, pr: CheckoutPull) {
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

export function isExactCheckoutPull(repo: LinkedRepo, pr: CheckoutPull, head: string) {
  return pr.head === head && hasSameRepoResult(repo, pr);
}

export async function ancestry(run: GitRunner, path: string, ancestor: string, tip: string) {
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

export async function adviseMissingUpstream({
  run,
  find,
  path,
  url,
  repo,
  source,
  head,
  branch,
}: {
  run: GitRunner;
  find: FindCheckoutPulls;
  path: string;
  url: string;
  repo: LinkedRepo;
  source: string;
  head: string;
  branch: string | null;
}): Promise<PullAdvice | undefined> {
  const found = await find(repo, source, head);
  // A PR that cannot be read may target another branch, so its presence alone keeps the advice unverified.
  const unreadable = found.some(pr => !readable(pr));
  const candidates = found
    .filter(readable)
    .filter(
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
  const advice: PullAdvice = {
    branch: branchName(choice.target),
    id: choice.id,
    url: safeAzureUrl(choice.url),
    strategy: choice.strategy,
    verified: false,
  };
  if (unreadable || !eligible.length || new Set(eligible.map(pr => pr.target)).size !== 1 || !choice.result) return advice;
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
    const [only, ...others] = tips;
    const tip = only?.[0] ?? '';
    if (others.length || !isCommit(tip)) return advice;
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

async function checkoutDestination(
  run: GitRunner,
  path: string,
  target: string,
  branch: string | null,
  url: string,
): Promise<PullAdvice['destination']> {
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

export function createCheckoutLookup({
  cached,
  lookup,
}: {
  cached: (id: string, source: string) => CheckoutPull[];
  lookup?: ((repo: LinkedRepo, source: string) => Promise<(CheckoutPull | UnreadableCheckoutPull)[]>) | undefined;
}): FindCheckoutPulls {
  return async (repo, source, head) => {
    const local = cached(repo.id, source);
    if (!lookup || local.some(pr => isExactCheckoutPull(repo, pr, head))) return local;
    try {
      const found = await lookup(repo, source);
      const remote = found.filter(readable);
      return [
        ...found.filter(pr => !readable(pr)),
        ...new Map([...remote, ...local.filter(pr => !remote.some(candidate => candidate.id === pr.id))].map(pr => [pr.id, pr])).values(),
      ];
    } catch {
      return local;
    }
  };
}
