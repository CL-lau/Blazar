import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceLedger } from '../device/ledger.ts';
import { lockWorkspace } from '../device/workspace.ts';

test('device workspace lock treats aliases as one root and permits a separate workspace', t => {
  const state = mkdtempSync(join(tmpdir(), 'blazar-workspace-lock-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const first = join(state, 'first');
  const second = join(state, 'second');
  const alias = join(state, 'alias');
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, alias, 'junction');
  const active = lockWorkspace(first, state);
  try {
    assert.throws(() => lockWorkspace(alias, state), /already owns this workspace/);
    lockWorkspace(second, state).release();
  } finally {
    active.release();
  }
  lockWorkspace(alias, state).release();
});

test('isolated device identities can share a Git source but exclude shared-directory execution', t => {
  const state = mkdtempSync(join(tmpdir(), 'blazar-shared-source-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const root = join(state, 'repository');
  mkdirSync(root);
  const first = lockWorkspace(root, state, 'device-one');
  const second = lockWorkspace(root, state, 'device-two');
  try {
    assert.equal(first.workspaceIdentity, second.workspaceIdentity);
    assert.notEqual(first.identity, second.identity);
    assert.throws(() => lockWorkspace(root, state), /already owns this workspace/);
    assert.throws(() => lockWorkspace(root, state, 'device-one'), /already using this device identity/);
    const ledger = new DeviceLedger(':memory:');
    try {
      ledger.begin(first.identity, 'first-run');
      ledger.begin(second.identity, 'second-run');
      ledger.begin('another-source', 'another-run');
      assert.equal(ledger.interrupted(first.identity), 'first-run');
      const runs = ledger.workspaceExecutions(first.workspaceIdentity);
      assert.deepEqual(new Set(runs.map(run => run.runId)), new Set(['first-run', 'second-run']));
      assert(ledger.clearExecution(first.identity, 'first-run'));
      assert.equal(ledger.interrupted(second.identity), 'second-run');
    } finally {
      ledger.close();
    }
  } finally {
    second.release();
    first.release();
  }
  const shared = lockWorkspace(root, state);
  try {
    assert.throws(() => lockWorkspace(root, state, 'device-three'), /already owns this workspace/);
  } finally {
    shared.release();
  }
});
