import { branchProblem } from './checkout-branches.js';

/** @param {string} pattern @param {string} ref */
function matchRef(pattern, ref) {
  if (pattern === ref) return '';
  const star = pattern.indexOf('*');
  if (star < 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) return null;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

/**
 * Check that Git can find the configured upstream of a new local branch.
 * @param {import('./checkout-git.js').GitRunner} run @param {string} path @param {import('./checkout-git.js').Upstream} target
 */
export async function verifyTrackingMapping(run, path, target) {
  const config = await run(path, ['config', '--null', '--get-all', `remote.${target.remote}.fetch`]).catch(error => {
    if (error?.code === 1 || error?.status === 1) return '';
    throw error;
  });
  const mappings = config.split('\0').flatMap(spec => {
    const [source, destination] = spec.replace(/^\+/, '').split(':');
    const match = matchRef(source, target.source);
    return match !== null && destination ? [destination.replace('*', () => match)] : [];
  });
  if (!mappings.length || !mappings.every(ref => ref === target.tracking)) {
    throw branchProblem('The Git fetch configuration does not map this branch to the watched remote. Review the remote in Git.');
  }
}
