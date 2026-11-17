// @ts-check

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** @typedef {{ pid: number|null, instance?: string, started?: string|null }} PullOwner */

const instance = randomUUID();
/** @type {Promise<string|null>|undefined} */
let bootId;

/** @param {number} pid */
async function linuxStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    bootId ||= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(value => value.trim(), () => null);
    const boot = await bootId;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The command name can contain spaces and parentheses; the fields after it cannot.
    const end = stat.lastIndexOf(') ');
    const startTime = end < 0 ? undefined : stat.slice(end + 2).split(' ')[19];
    return boot && startTime && /^\d+$/.test(startTime) ? `${boot}:${startTime}` : null;
  } catch { return null; }
}

/** @returns {Promise<PullOwner>} */
export async function capturePullOwner() {
  return { pid: process.pid, instance, started: await linuxStart(process.pid) };
}

/** @param {PullOwner} owner */
export async function pullOwnerRunning({ pid, instance: savedInstance, started }) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 0) return false;
  if (pid === process.pid) return savedInstance === instance;
  try { process.kill(pid, 0); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; }
  const current = started ? await linuxStart(pid) : null;
  // An inaccessible process cannot safely be ruled out by another server.
  return !current || current === started;
}
