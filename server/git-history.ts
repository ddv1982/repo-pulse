import { createHash } from 'node:crypto';
import type { GitRunner } from './checkout-git.ts';
import type { GitHistoryPage } from '../src/contract.d.ts';

const fullId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const pageSize = 50;

export async function readGitHistory(run: GitRunner, path: string, defaultBranch: string | null | undefined, cursor: string | null) {
  const git = (args: string[], input?: string) =>
    run(path, args, { guard: { GIT_ALLOW_PROTOCOL: '' }, ...(input === undefined ? {} : { input }) });
  const [head, refs, shallow] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
      value => value.trim(),
      error => {
        if (error.code === 1) return '';
        throw error;
      },
    ),
    git([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(HEAD)%00%(upstream)%00%(upstream:remotename)%00%(symref)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]),
    git(['rev-parse', '--is-shallow-repository']),
  ]);
  const references = refs
    .trimEnd()
    .split('\n')
    .flatMap(line => {
      const [name, object, peeled, type, peeledType, current, upstream, remote, symbolic] = line.split('\0');
      const id = type === 'commit' ? object : peeledType === 'commit' ? peeled : '';
      return name && id && fullId.test(id) ? [{ name, id, current, upstream, remote, symbolic }] : [];
    });
  const current = references.find(ref => ref.current === '*' && ref.id === head);
  const upstream = references.find(ref => ref.name === current?.upstream);
  const remote = current?.remote && current.remote !== '.' ? current.remote : 'origin';
  const remotePrefix = `refs/remotes/${remote}/`;
  const defaultRef = references.find(ref => ref.name === remotePrefix + defaultBranch?.slice(11));
  const remoteHead = references.find(ref => ref.name === remotePrefix + 'HEAD')?.symbolic;
  const base = current && (references.find(ref => ref.name === remoteHead) ?? defaultRef);
  const tips = [...new Set([head, upstream?.id, base ? base.id : undefined].filter((id): id is string => Boolean(id && fullId.test(id))))];
  const snapshot = createHash('sha256')
    .update(JSON.stringify([head, refs, shallow]))
    .digest('hex');
  const [, offsetText, version] = cursor?.match(/^(\d{1,8})\.([0-9a-f]{64})$/) ?? [];
  const offset = Number(offsetText ?? 0);
  if (cursor !== null && (!version || offset === 0 || offset % pageSize !== 0)) {
    throw Object.assign(new Error('Invalid Git history page.'), { status: 400 });
  }
  if (version && version !== snapshot) {
    throw Object.assign(new Error('Git references changed. Reload the graph to continue.'), { status: 409 });
  }

  const labels = new Map<string, string[]>();
  for (const ref of references) {
    if (ref.symbolic) continue;
    const label = ref.name.replace(/^refs\/(heads|remotes|tags)\//, '');
    const existing = labels.get(ref.id);
    if (existing) existing.push(label);
    else labels.set(ref.id, [label]);
  }
  const output = tips.length
    ? await git(
        [
          'log',
          '--topo-order',
          '--no-show-signature',
          '--no-notes',
          '--no-patch',
          '-z',
          '--format=%H%x00%P%x00%aN%x00%s',
          `--max-count=${pageSize + 1}`,
          `--skip=${offset}`,
          '--stdin',
        ],
        tips.join('\n') + '\n',
      )
    : '';
  const { commits, more } = parseCommits(output, labels);

  return {
    head,
    branch: current?.name.slice(11) ?? null,
    upstream: upstream?.name.replace(/^refs\/(heads|remotes)\//, '') ?? null,
    shallow: shallow.trim() === 'true',
    commits,
    nextCursor: more ? `${offset + pageSize}.${snapshot}` : null,
  } satisfies GitHistoryPage;
}

function parseCommits(output: string, labels: Map<string, string[]>) {
  const fields = output.split('\0');
  const commits: GitHistoryPage['commits'] = [];
  for (let i = 0; i + 3 < fields.length && commits.length < pageSize; i += 4) {
    const [id, parents, author, subject] = fields.slice(i, i + 4);
    if (!id || !fullId.test(id) || parents === undefined || author === undefined || subject === undefined) {
      throw new Error('Git returned unreadable commit history.');
    }
    commits.push({ id, parents: parents ? parents.split(' ') : [], author, subject, refs: labels.get(id) ?? [], activity: [] });
  }

  return { commits, more: fields.length > pageSize * 4 + 1 };
}
