import { createHash } from 'node:crypto';
import { ancestry, isCommit } from './checkout-advice.ts';
import { readRef } from './checkout-branches.ts';
import { conflict } from './errors.ts';
import { isSymbolicRef } from './checkout-delete-guard.cjs';
import { compareUpstream } from './checkout-observations.ts';
import type { GitRunner, Upstream } from './checkout-git.ts';
import type { Repository as LinkedRepo } from '../src/contract.d.ts';

function archivePrefix(repo: LinkedRepo, target: Upstream) {
  const upstream = createHash('sha256')
    .update(
      JSON.stringify([target.source, target.tracking, ...[repo.organization, repo.project, repo.name].map(value => value.toLowerCase())]),
    )
    .digest('hex');
  return `refs/repo-pulse/upstream-rewrites/${upstream}/`;
}

export async function readDirectCommit(run: GitRunner, path: string, ref: string) {
  const output = await run(path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)', '--', ref]);
  const sample = output
    .split('\n')
    .map(line => line.trimEnd().split('\0'))
    .find(([name]) => name === ref);
  if (!sample) {
    if (await isSymbolicRef(run, path, ref)) throw conflict('The tracking ref is symbolic. Review it in Git.');
    if (await readRef(run, path, ref)) throw conflict('The Git ref changed while it was being read. Try again.');
    return null;
  }
  // isCommit refuses '' as it refuses a missing field.
  const [, oid = '', symbolic, type] = sample;
  if (symbolic) throw conflict('The tracking ref is symbolic. Review it in Git.');
  if (!isCommit(oid) || type !== 'commit') {
    throw conflict('The tracking ref does not point to a commit. Review it in Git.');
  }
  return oid;
}

/**
 * Confirm the ref type after Git has locked every ref and before sending commit.
 * The lock-held read matters because no-deref can replace a symbolic ref on older Git.
 */
async function writeRef(
  run: GitRunner,
  path: string,
  hooks: string,
  ref: string,
  previous: string | null,
  tip: string,
  archives: { ref: string; oid: string }[] = [],
  verify?: () => Promise<void>,
) {
  const input = ['start'];
  for (const archive of archives) input.push('option no-deref', `verify ${archive.ref} ${archive.oid}`);
  input.push('option no-deref', previous ? `update ${ref} ${tip} ${previous}` : `create ${ref} ${tip}`, 'prepare', '');
  try {
    await run(
      path,
      ['-c', `core.hooksPath=${hooks}`, 'update-ref', '--create-reflog', '-m', 'Repo Pulse: refresh upstream for branch switch', '--stdin'],
      {
        input: input.join('\n'),
        prepare: async () => {
          for (const name of [ref, ...archives.map(archive => archive.ref)]) {
            if (await isSymbolicRef(run, path, name)) throw conflict('A Git ref became symbolic. Review it in Git.');
          }
          await verify?.();
        },
      },
    );
  } catch {
    throw conflict('Git could not verify and refresh the refs. The checkout was not switched. Review the refs and try again.');
  }
}

/**
 * Archives are Git refs so the old objects stay reachable after an interruption or SQLite failure.
 * Write them before updating the tracker and verify them again while the tracker is locked.
 */
export async function refreshSwitchTracking(
  run: GitRunner,
  path: string,
  hooks: string,
  repo: LinkedRepo,
  target: Upstream,
  previous: string | null,
  tip: string,
  rewrites: { previous: string; tip: string }[],
  verify: () => Promise<void>,
) {
  const archives = [];
  for (const rewrite of rewrites) {
    const oid = rewrite.previous;
    const ref = `${archivePrefix(repo, target)}${rewrite.tip}/${oid}`;
    const existing = await readDirectCommit(run, path, ref);
    if (existing && existing !== oid) throw conflict('The upstream recovery ref changed. Review it in Git.');
    if (!existing) await writeRef(run, path, hooks, ref, null, oid, [], verify);
    archives.push({ ref, oid });
  }
  if (previous !== tip || archives.length) await writeRef(run, path, hooks, target.tracking, previous, tip, archives, verify);
}

export async function archivedSwitchRewrite(run: GitRunner, path: string, repo: LinkedRepo, target: Upstream, head: string) {
  const prefix = archivePrefix(repo, target);
  const output = await run(path, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)', '--', prefix]);
  if (!output.trim()) return undefined;
  const tracked = await readDirectCommit(run, path, target.tracking);
  if (!tracked || head === tracked) return undefined;
  for (const row of output.trim().split('\n')) {
    const [old = '', ref, symbolic] = row.trim().split(' ');
    if (symbolic || !isCommit(old) || !ref?.startsWith(prefix)) continue;
    const [next = '', archived] = ref.slice(prefix.length).split('/');
    if (!isCommit(next) || archived !== old) continue;
    const baseline = await ancestry(run, path, old, tracked);
    if (baseline === true) continue;
    const accepted = (await ancestry(run, path, next, tracked)) === true ? next : tracked;
    if ((await ancestry(run, path, accepted, head)) !== true) return compareUpstream(run, path, old, tracked, baseline === false);
  }
  return undefined;
}
