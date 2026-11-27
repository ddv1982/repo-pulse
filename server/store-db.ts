import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The one SQLite connection a store's modules share: its statement cache and its only transaction owner. Each module
 * writes through `q` and `transaction`, so a write that spans modules, such as a sync page, is still one transaction.
 */
export type StoreDb = {
  db: DatabaseSync;
  path: string;
  /** Prepares and caches static SQL statements for the lifetime of this connection. */
  q: (sql: string) => StatementSync;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
};

export function openStoreDb(path: string): StoreDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  // Another process reading or writing the file, such as a probe script, makes a write wait briefly instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');
  const statements: Map<string, StatementSync> = new Map();
  const q = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    db,
    path,
    q,
    transaction,
    close() {
      statements.clear();
      db.close();
    },
  };
}
