import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lockDatabaseFile } from '../../packages/storage/exclusive.ts';

export function lockWorkspace(directory: string, stateDirectory: string) {
  const root = realpathSync(directory);
  const info = statSync(root, { bigint: true });
  if (!info.isDirectory()) throw new Error('BLAZAR_WORKSPACE_PATH must be a directory');
  const identity = info.ino === 0n ? root : `${info.dev}:${info.ino}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  const path = join(stateDirectory, 'workspace-' + digest + '.sqlite');
  return { root, identity: digest, release: lockDatabaseFile(path, 'Another Blazar device already owns this workspace') };
}
