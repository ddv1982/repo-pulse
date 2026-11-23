import { branchProblem } from './checkout-branches.ts';

function matchRef(pattern: string, ref: string) {
  if (pattern === ref) return '';
  const star = pattern.indexOf('*');
  if (star < 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix) || ref.length < prefix.length + suffix.length) return null;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

/**
 * Check the mapping in both directions before writing a shared tracking ref.
 */
export async function verifyTrackingMapping(
  run: import('./checkout-git.ts').GitRunner,
  path: string,
  target: import('./checkout-git.ts').Upstream,
) {
  const config = await run(path, ['config', '--null', '--get-regexp', '^remote\\..*\\.fetch$']).catch(error => {
    if (error?.code === 1 || error?.status === 1) return '';
    throw error;
  });
  const mappings = config.split('\0').flatMap(entry => {
    const newline = entry.indexOf('\n');
    if (newline < 0) return [];
    const remote = entry.slice(7, newline - 6);
    // split always returns at least one part.
    const [source = '', destination] = entry
      .slice(newline + 1)
      .replace(/^\+/, '')
      .split(':');
    return [{ remote, source, destination }];
  });
  const forwards = mappings.flatMap(({ remote, source, destination }) =>
    remote === target.remote && destination && matchRef(source, target.source) !== null ? [{ source, destination }] : [],
  );
  const excluded = mappings.some(
    ({ remote, source }) => remote === target.remote && source.startsWith('^') && matchRef(source.slice(1), target.source) !== null,
  );
  const collision = mappings.some(({ remote, source, destination }) => {
    const match = destination ? matchRef(destination, target.tracking) : null;
    return match !== null && (remote !== target.remote || source.replace('*', () => match) !== target.source);
  });
  if (
    excluded ||
    collision ||
    !forwards.length ||
    forwards.some(({ source, destination }) => destination.replace('*', () => matchRef(source, target.source) ?? '') !== target.tracking)
  ) {
    throw branchProblem('The Git fetch configuration does not map this branch to the watched remote. Review the remote in Git.');
  }
}
