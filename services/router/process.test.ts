import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawnWorker } from '../../packages/workers/process.ts';

test('worker stop kills a TERM-resistant descendant after its parent exits', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'blazar-worker-stop-'));
  const file = join(dir, 'heartbeat');
  const grandchild = `
    const { appendFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    console.log('ready');
    setInterval(() => appendFileSync(process.argv[1], 'a'), 20);
  `;
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, process.argv[1]], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    child.stdout.once('data', () => {
      console.log(child.pid);
      child.stdout.destroy();
      child.unref();
    });
    setInterval(() => {}, 1000);
  `;
  const worker = spawnWorker({ executable: process.execPath, args: ['-e', script, file], label: 'fixture' }, dir);
  let descendant = 0;
  t.after(async () => {
    await worker.stop();
    if (descendant) {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* The process already exited. */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const [line] = await once(worker.child.stdout, 'data');
  descendant = Number(String(line).trim());
  assert.ok(descendant > 0);
  await worker.stop();
  const before = readFileSync(file, 'utf8');
  await delay(100);
  assert.equal(readFileSync(file, 'utf8'), before);
  descendant = 0;
});
