import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
