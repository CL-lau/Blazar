import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceLedger } from './ledger.ts';
import { lockWorkspace } from './workspace.ts';

const [runId, ...extra] = process.argv.slice(2);
const workspace = process.env.BLAZAR_WORKSPACE_PATH;
if (!workspace || !runId || extra.length || !/^[a-f0-9-]{36}$/.test(runId)) {
  console.error('Set BLAZAR_WORKSPACE_PATH and pass the interrupted run ID.');
  process.exitCode = 2;
} else {
  const state = join(homedir(), '.blazar-device');
  const locked = lockWorkspace(workspace, state);
  try {
    const ledger = new DeviceLedger(join(state, 'ledger.sqlite'));
    try {
      if (!ledger.clearExecution(locked.identity, runId)) throw new Error('No matching interrupted run');
      console.log('Cleared interrupted run ' + runId);
    } finally {
      ledger.close();
    }
  } finally {
    locked.release();
  }
}
