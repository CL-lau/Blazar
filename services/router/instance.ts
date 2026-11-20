import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { lockDatabaseFile } from '../../packages/storage/exclusive.ts';

export function lockRouter(databasePath: string) {
  if (databasePath === ':memory:' || !databasePath.trim()) {
    throw new Error('Blazar Router requires a persistent database path');
  }
  const absolutePath = resolve(databasePath);
  let path: string;
  try {
    path = realpathSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    path = join(realpathSync(dirname(absolutePath)), basename(absolutePath));
  }
  const directory = dirname(path);
  const lockPath = join(directory, '.blazar-router-lock.sqlite');
  if (path === lockPath) throw new Error('BLAZAR_DB uses the reserved Router lock filename');

  return { path, release: lockDatabaseFile(lockPath, 'A Blazar Router already owns this data directory') };
}
