import { readdir, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { discoverRepositories } from './repositories.ts';

/** Only immediate folder names and Git remotes; browsing never contacts Azure. */
export async function browseFolders(
  input: unknown,
  { home = homedir(), discover = discoverRepositories }: { home?: string; discover?: typeof discoverRepositories } = {},
): Promise<import('../src/contract.ts').FoldersResponse> {
  let path;
  if (input === undefined || input === '') {
    const projects = join(home, 'projects');
    path = await stat(projects)
      .then(entry => (entry.isDirectory() ? projects : home))
      .catch(() => home);
  } else {
    if (typeof input !== 'string' || input.includes('\0') || input.length > 4096)
      throw Object.assign(new Error('Choose a valid local folder.'), { status: 400 });
    path = resolve(input === '~' ? home : input.startsWith('~/') ? join(home, input.slice(2)) : input);
  }
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw Object.assign(new Error('This folder cannot be opened. Choose another local folder.'), { status: 400 });
  }
  const folders = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name));
  const root = parse(path).root;
  let part = root;
  const breadcrumbs = [{ name: root, path: root }];
  for (const name of path.slice(root.length).split(sep).filter(Boolean)) {
    part = join(part, name);
    breadcrumbs.push({ name, path: part });
  }
  const found = await discover(path);
  const warnings = [...found.warnings];
  if (folders.length > 200) warnings.push('Showing the first 200 folders. Choose a narrower folder to continue.');
  return {
    path,
    parent: dirname(path) === path ? null : dirname(path),
    breadcrumbs,
    folders: folders.slice(0, 200).map(entry => ({ name: entry.name, path: join(path, entry.name) })),
    repositories: found.repositories,
    warnings,
  };
}
