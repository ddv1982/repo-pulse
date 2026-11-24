import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Keeps a second app off this database while this one runs: checkout write locks and sync state live in one process.
 * The lock is SQLite's own exclusive file lock on a separate file, held for as long as the connection is open. The
 * operating system drops it when the process ends, even in a crash, so a lock never goes stale. Live and demo data
 * each have their own lock and can run side by side. The lock file sits next to the path given, so a database file
 * that is itself a symbolic link into another data directory is not protected; the data directory is the app's own.
 */
export async function lockDatabase(database: string, { timeout = 2000 }: { timeout?: number } = {}) {
  const file = `${database}.lock`;
  const deadline = performance.now() + timeout;
  for (;;) {
    const lock = new DatabaseSync(file);
    try {
      // In exclusive locking mode the lock taken by the first write is kept after its commit, until close().
      lock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
      return lock;
    } catch (error) {
      lock.close();
      if ((error as { errcode?: unknown }).errcode !== 5) throw error; // 5 is SQLITE_BUSY: another connection holds it.
    }
    // Two starts at once can each keep the shared lock the other needs, and SQLite then refuses both at once instead
    // of waiting. Closing drops that shared lock; a short random pause lets one of them win on the next try.
    if (performance.now() >= deadline) {
      throw Object.assign(new Error(`Another Repo Pulse is already running on this data (lock file ${file}). Stop it first.`), {
        code: 'DATA_DIR_LOCKED',
      });
    }
    await sleep(10 + Math.random() * 40);
  }
}
