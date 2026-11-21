import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lockDatabaseFile } from '../../packages/storage/exclusive.ts';

export function lockWorkspace(directory: string, stateDirectory: string, isolatedScope?: string) {
  const root = realpathSync(directory);
  const info = statSync(root, { bigint: true });
  if (!info.isDirectory()) throw new Error('BLAZAR_WORKSPACE_PATH must be a directory');
  const identity = info.ino === 0n ? root : `${info.dev}:${info.ino}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  const path = join(stateDirectory, 'workspace-' + digest + '.sqlite');
  const releaseWorkspace = lockDatabaseFile(path, 'Another Blazar device already owns this workspace', isolatedScope !== undefined);
  if (isolatedScope === undefined) return { root, identity: digest, workspaceIdentity: digest, release: releaseWorkspace };
  const scope = createHash('sha256').update(isolatedScope).digest('hex');
  try {
    const releaseDevice = lockDatabaseFile(join(stateDirectory, 'workspace-' + digest + '-' + scope + '.sqlite'),
      'Another Blazar device is already using this device identity for the workspace');
    return { root, workspaceIdentity: digest, identity: digest + ':' + scope,
      release() { releaseDevice(); releaseWorkspace(); } };
  } catch (error) {
    releaseWorkspace();
    throw error;
  }
}
