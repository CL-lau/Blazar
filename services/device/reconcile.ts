import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceLedger } from './ledger.ts';
import { lockWorkspace } from './workspace.ts';
import { inspectRunWorktree } from './execution/git-worktree.ts';

const args = process.argv.slice(2);
const inspect = args[0] === '--inspect';
const [runId, ...extra] = inspect ? args.slice(1) : args;
const workspace = process.env.BLAZAR_WORKSPACE_PATH;
if (!workspace || !runId || extra.length || !/^[a-f0-9-]{36}$/.test(runId)) {
  console.error('Set BLAZAR_WORKSPACE_PATH and pass [--inspect] RUN_ID.');
  process.exitCode = 2;
} else {
  const state = join(homedir(), '.blazar-device');
  const locked = lockWorkspace(workspace, state);
  try {
    const ledger = new DeviceLedger(join(state, 'ledger.sqlite'));
    try {
      const interrupted = ledger.workspaceExecutions(locked.workspaceIdentity).find(row => row.runId === runId);
      if (!interrupted) throw new Error('No matching interrupted run');
      if (inspect) {
        console.log(JSON.stringify(await inspectRunWorktree(locked.root, join(state, 'run-worktrees'), runId), null, 2));
      } else {
        if (!ledger.clearExecution(interrupted.identity, runId)) throw new Error('No matching interrupted run');
        console.log('Cleared interrupted run ' + runId);
      }
    } finally {
      ledger.close();
    }
  } finally {
    locked.release();
  }
}
