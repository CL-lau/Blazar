import { chmod, link, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { lockRouter } from './instance.ts';

async function assertAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Destination already exists: ' + path);
}

function verifyDatabase(database: DatabaseSync) {
  const tables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type='table' AND name IN ('task', 'event', 'artifact', 'device')`).get();
  if (tables?.count !== 4) throw new Error('Source is not a Blazar database');
  const result = database.prepare('PRAGMA integrity_check(1)').get();
  if (result?.integrity_check !== 'ok') throw new Error('Blazar database failed SQLite integrity check');
}

export async function copyRouterDatabase(command: 'backup' | 'restore', configuredPath: string, archive: string) {
  // Preserve a dangling destination symlink as an existing entry.
  if (command === 'restore') await assertAbsent(resolve(configuredPath));
  const instance = lockRouter(configuredPath);
  try {
    const source = command === 'backup' ? instance.path : resolve(archive);
    const outputPath = command === 'backup' ? resolve(archive) : instance.path;
    const destination = join(await realpath(dirname(outputPath)), basename(outputPath));
    if (basename(destination) === '.blazar-router-lock.sqlite' ||
        /-(wal|shm|journal)$/.test(destination)) {
      throw new Error('Destination uses a reserved SQLite filename');
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      await assertAbsent(destination + suffix);
    }
    const temp = await mkdtemp(join(dirname(destination), '.blazar-backup-'));
    try {
      const staging = join(temp, 'database.sqlite');
      const database = new DatabaseSync(source, { readOnly: true });
      try {
        verifyDatabase(database);
        await backup(database, staging);
      } finally {
        database.close();
      }
      const verification = new DatabaseSync(staging);
      try {
        verification.exec('PRAGMA journal_mode=DELETE');
        verifyDatabase(verification);
      } finally {
        verification.close();
      }
      await chmod(staging, 0o600);
      // Publish the fully checked file without replacing another writer's destination.
      await link(staging, destination);
      return destination;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } finally {
    instance.release();
  }
}
