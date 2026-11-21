import { DatabaseSync } from 'node:sqlite';

export function lockDatabaseFile(path: string, busyMessage: string, shared = false) {
  // Keep the rollback-journal transaction open so SQLite releases the lock on process exit.
  const lock = new DatabaseSync(path);
  try {
    lock.exec(`PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY);`);
    if (shared) {
      lock.exec('BEGIN');
      lock.prepare('SELECT id FROM instance_lock LIMIT 1').get();
    } else {
      lock.exec('BEGIN EXCLUSIVE');
    }
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error(busyMessage, { cause: error });
    }
    throw error;
  }
  return () => lock.close();
}
