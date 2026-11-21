import { observationConfig } from '../../packages/computer-use/observe.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';
import { probeAcp } from '../../packages/workers/acp.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceLedger } from './ledger.ts';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceClient } from './client.ts';
import { lockWorkspace } from './workspace.ts';
import { gitRunWorktrees } from './execution/git-worktree.ts';

const token = process.env.BLAZAR_DEVICE_TOKEN;
const workspace = process.env.BLAZAR_WORKSPACE_PATH;
if (!token || !workspace) throw new Error('Set BLAZAR_DEVICE_TOKEN and BLAZAR_WORKSPACE_PATH');
const router = new URL(process.env.BLAZAR_ROUTER_URL ?? 'http://127.0.0.1:4199');
const stateDirectory = join(homedir(), '.blazar-device');
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
const mode = process.env.BLAZAR_DEVICE_WORKER ?? 'preview';
const observation = mode === 'observe' ? observationConfig(process.env, join(stateDirectory, 'desktop-lock.sqlite')) : undefined;
const worker = observation ? undefined : await resolveWorker(mode, process.env.BLAZAR_WORKER_MANIFEST, process.env.BLAZAR_WORKER_EXECUTABLE);
const workspaceLock = lockWorkspace(workspace, stateDirectory);
try {
  const worktrees = worker && process.env.BLAZAR_WORKER_GIT_WORKTREE === '1'
    ? await gitRunWorktrees(workspaceLock.root, stateDirectory) : undefined;
  if (worker && !worktrees && (worker.protocol ?? 'acp') === 'acp') {
    try {
      await probeAcp(worker, workspaceLock.root, AbortSignal.timeout(5_000));
    } catch (error) {
      throw new Error(worker.label + ' failed the ACP startup handshake. Run npm run device:probe for diagnostics.', { cause: error });
    }
  }
  const ledger = new DeviceLedger(join(stateDirectory, 'ledger.sqlite'));
  try {
    const interrupted = ledger.interrupted(workspaceLock.identity);
    if (interrupted) console.error('Workspace has an interrupted run that requires reconciliation: ' + interrupted);
    const device = new DeviceClient(router, token, workspaceLock.root, ledger, worker, observation, workspaceLock.identity, worktrees);
    const shutdown = new AbortController();
    process.once('SIGINT', () => shutdown.abort());
    process.once('SIGTERM', () => shutdown.abort());
    try {
      while (!shutdown.signal.aborted) {
        try {
          if (await device.runOnce(shutdown.signal)) continue;
        } catch (error) {
          if (!shutdown.signal.aborted) console.error(error instanceof Error ? error.message : 'Device request failed');
        }
        await delay(1_000, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    } finally {
      device.close();
    }
  } finally {
    ledger.close();
  }
} finally {
  workspaceLock.release();
}
