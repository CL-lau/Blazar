import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lockRouter } from './instance.ts';

test('Router locks its canonical data directory until its process exits', { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-lock-'));
  const database = join(root, 'router.sqlite');
  const alias = join(root, 'alias');
  symlinkSync(root, alias, 'dir');
  const module = new URL('./instance.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { lockRouter } from ${JSON.stringify(module)};
    const instance = lockRouter(process.argv[1]);
    console.log('locked');
    setInterval(() => { if (!instance.path) process.exit(1); }, 1000);
  `, database], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  try {
    const ready = once(child.stdout!, 'data');
    const [message] = await Promise.race([ready, exit.then(() => { throw new Error('Router exited before acquiring lock'); })]);
    assert.equal(message.toString().trim(), 'locked');
    assert.throws(() => lockRouter(join(alias, 'another.sqlite')), /already owns/);
    child.kill('SIGKILL');
    await exit;
    lockRouter(database).release();
    lockRouter(database).release();
  } finally {
    child.kill('SIGKILL');
    await exit;
    rmSync(root, { recursive: true, force: true });
  }
});
