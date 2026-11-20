import { DatabaseSync } from 'node:sqlite';

export function lockDatabaseFile(path: string, busyMessage: string) {
  // Use a committed schema and hold an exclusive transaction without writing to it.
  const lock = new DatabaseSync(path);
  try {
    lock.exec(`PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY);
      BEGIN EXCLUSIVE`);
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error(busyMessage, { cause: error });
    }
    throw error;
  }
  return () => lock.close();
}
