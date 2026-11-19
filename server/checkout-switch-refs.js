import { createHash } from 'node:crypto';
import { ancestry, isCommit } from './checkout-advice.js';
import { branchProblem, readRef } from './checkout-branches.js';
import { isSymbolicRef } from './checkout-delete-guard.cjs';
import { compareUpstream } from './checkout-observations.js';

/** @typedef {import('./checkout-git.js').GitRunner} GitRunner */
/** @typedef {import('./checkout-git.js').LinkedRepo} LinkedRepo */
/** @typedef {import('./checkout-git.js').Upstream} Upstream */

/** @param {LinkedRepo} repo @param {Upstream} target */
function archivePrefix(repo, target) {
  const upstream = createHash('sha256')
    .update(
      JSON.stringify([target.source, target.tracking, ...[repo.organization, repo.project, repo.name].map(value => value.toLowerCase())]),
    )
    .digest('hex');
  return `refs/repo-pulse/upstream-rewrites/${upstream}/`;
}

/** @param {GitRunner} run @param {string} path @param {string} ref */
export async function readDirectCommit(run, path, ref) {
  const output = await run(path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)', '--', ref]);
  const sample = output
    .split('\n')
    .map(line => line.trimEnd().split('\0'))
    .find(([name]) => name === ref);
  if (!sample) {
    if (await isSymbolicRef(run, path, ref)) throw branchProblem('The tracking ref is symbolic. Review it in Git.');
    if (await readRef(run, path, ref)) throw branchProblem('The Git ref changed while it was being read. Try again.');
    return null;
  }
  const [, oid, symbolic, type] = sample;
  if (symbolic) throw branchProblem('The tracking ref is symbolic. Review it in Git.');
  if (!isCommit(oid) || type !== 'commit') {
    throw branchProblem('The tracking ref does not point to a commit. Review it in Git.');
  }
  return oid;
}

/**
 * Confirm the ref type after Git has locked every ref and before sending commit.
 * The lock-held read matters because no-deref can replace a symbolic ref on older Git.
 * @param {GitRunner} run @param {string} path @param {string} hooks @param {string} ref
 * @param {string|null} previous @param {string} tip @param {{ref: string, oid: string}[]} [archives]
 * @param {() => Promise<void>} [verify]
 */
async function writeRef(run, path, hooks, ref, previous, tip, archives = [], verify) {
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
            if (await isSymbolicRef(run, path, name)) throw branchProblem('A Git ref became symbolic. Review it in Git.');
          }
          await verify?.();
        },
      },
    );
  } catch {
    throw branchProblem('Git could not verify and refresh the refs. The checkout was not switched. Review the refs and try again.');
  }
}

/**
 * Archives are Git refs so the old objects stay reachable after an interruption or SQLite failure.
 * Write them before updating the tracker and verify them again while the tracker is locked.
 * @param {GitRunner} run @param {string} path @param {string} hooks @param {LinkedRepo} repo
 * @param {Upstream} target @param {string|null} previous @param {string} tip @param {{previous: string, tip: string}[]} rewrites
 * @param {() => Promise<void>} verify
 */
export async function refreshSwitchTracking(run, path, hooks, repo, target, previous, tip, rewrites, verify) {
  const archives = [];
  for (const rewrite of rewrites) {
    const oid = rewrite.previous;
    const ref = `${archivePrefix(repo, target)}${rewrite.tip}/${oid}`;
    const existing = await readDirectCommit(run, path, ref);
    if (existing && existing !== oid) throw branchProblem('The upstream recovery ref changed. Review it in Git.');
    if (!existing) await writeRef(run, path, hooks, ref, null, oid, [], verify);
    archives.push({ ref, oid });
  }
  if (previous !== tip || archives.length) await writeRef(run, path, hooks, target.tracking, previous, tip, archives, verify);
}

/** @param {GitRunner} run @param {string} path @param {LinkedRepo} repo @param {Upstream} target
 * @param {string} head
 */
export async function archivedSwitchRewrite(run, path, repo, target, head) {
  const prefix = archivePrefix(repo, target);
  const output = await run(path, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)', '--', prefix]);
  if (!output.trim()) return undefined;
  const tracked = await readDirectCommit(run, path, target.tracking);
  if (!tracked || head === tracked) return undefined;
  for (const row of output.trim().split('\n')) {
    const [old, ref, symbolic] = row.trim().split(' ');
    if (symbolic || !isCommit(old) || !ref?.startsWith(prefix)) continue;
    const [next, archived] = ref.slice(prefix.length).split('/');
    if (!isCommit(next) || archived !== old) continue;
    const baseline = await ancestry(run, path, old, tracked);
    if (baseline === true) continue;
    const accepted = (await ancestry(run, path, next, tracked)) === true ? next : tracked;
    if ((await ancestry(run, path, accepted, head)) !== true) return compareUpstream(run, path, old, tracked, baseline === false);
  }
  return undefined;
}
