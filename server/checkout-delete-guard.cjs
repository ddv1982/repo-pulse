#!/usr/bin/env node
// @ts-check

const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { promisify } = require('node:util');

const exec = promisify(execFile);

/** @typedef {(path: string, args: string[]) => Promise<string>} RunGit */

/** @param {RunGit} run @param {string} path @param {string} ref */
async function worktreeUsesBranch(run, path, ref) {
  const entries = (await run(path, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  for (const entry of entries) {
    const [header, ...fields] = entry.split('\0');
    if (fields.includes(`branch ${ref}`)) return true;
    if (!fields.includes('detached')) continue;
    const checkout = header.slice('worktree '.length);
    for (const marker of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
      const location = (await run(checkout, ['rev-parse', '--path-format=absolute', '--git-path', marker])).replace(/\r?\n$/, '');
      const owner = await readFile(location, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (owner.trimEnd() === (marker === 'BISECT_START' ? ref.slice('refs/heads/'.length) : ref)) return true;
    }
  }
  return false;
}
exports.worktreeUsesBranch = worktreeUsesBranch;

/** @param {RunGit} run @param {string} path @param {string} ref */
async function isSymbolicRef(run, path, ref) {
  try {
    await run(path, ['symbolic-ref', '--quiet', '--no-recurse', ref]);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}
exports.isSymbolicRef = isSymbolicRef;

if (require.main === module && process.argv[2] === 'prepared') {
  // Git has both refs locked while this hook checks their types and the worktrees.
  const { REPO_PULSE_DELETE_REF: ref, REPO_PULSE_DELETE_ARCHIVE: archive } = process.env;
  const path = process.cwd();
  /** @type {RunGit} */
  const git = async (directory, args) => {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    // Run from this hook's own folder: Windows looks for a bare `git` in the working directory before PATH.
    return (await exec('git', ['-C', directory, ...args], { env, cwd: __dirname })).stdout;
  };
  (async () => {
    readFileSync(0, 'utf8');
    if (
      !ref?.startsWith('refs/heads/') ||
      !archive?.startsWith('refs/repo-pulse/archive/') ||
      (await isSymbolicRef(git, path, ref)) ||
      (await isSymbolicRef(git, path, archive)) ||
      (await worktreeUsesBranch(git, path, ref))
    )
      process.exitCode = 1;
  })().catch(() => {
    process.exitCode = 1;
  });
}
