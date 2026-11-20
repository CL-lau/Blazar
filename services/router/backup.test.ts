import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyRouterDatabase } from './backup.ts';
import { lockRouter } from './instance.ts';
import { MemoryStore } from './memory.ts';
import { TaskStore } from './store.ts';

test('offline backup restores tasks, artifact bytes, and app memory into a new database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'blazar-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source.sqlite');
  const archive = join(dir, 'archive.sqlite');
  const target = join(dir, 'restored.sqlite');
  const active = lockRouter(source);
  const tasks = new TaskStore(source);
  const memory = new MemoryStore(source);
  const task = tasks.create('owner', 'desktop', 'one', 'main', 'Review');
  const { run } = tasks.claim('owner', 'main', 'device', 10, 100)!;
  assert.equal(tasks.finish(run.id, 'device', 20, {
    status: 'succeeded', result: 'Reviewed', artifact: { name: 'result.txt', text: 'notes' },
  }), true);
  const connection = memory.connect('owner', 'feishu', 'team');
  memory.remember('owner', 'main', 'launch notes', { connection, resource: 'doc', revision: '1' });
  tasks.close();
  memory.close();

  try {
    await assert.rejects(copyRouterDatabase('backup', source, archive), /already owns/);
  } finally {
    active.release();
  }
  await copyRouterDatabase('backup', source, archive);
  if (process.platform !== 'win32') assert.equal(statSync(archive).mode & 0o777, 0o600);
  await assert.rejects(copyRouterDatabase('backup', source, archive), /already exists/);
  await assert.rejects(copyRouterDatabase('restore', source, archive), /already exists/);
  writeFileSync(target + '-wal', 'stale');
  await assert.rejects(copyRouterDatabase('restore', target, archive), /already exists/);
  rmSync(target + '-wal');
  await copyRouterDatabase('restore', target, archive);

  const restored = new TaskStore(target);
  const restoredMemory = new MemoryStore(target);
  try {
    assert.equal(restored.get('owner', task.id)?.result, 'Reviewed');
    const artifact = restored.snapshot('owner').artifacts[0];
    assert.equal(Buffer.from(restored.artifact('owner', String(artifact.id))!.content).toString(), 'notes');
    assert.equal(restored.artifact('another', String(artifact.id)), undefined);
    assert.equal(restoredMemory.recall('owner', 'main', 'launch', [connection])[0].body, 'launch notes');
  } finally {
    restored.close();
    restoredMemory.close();
  }
});
