import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';

test('a device crash blocks the workspace after restart and credential rotation', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'blazar-interrupted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.sqlite');
  const store = new TaskStore(':memory:');
  const device = store.registerDevice('owner', 'Device', 'project');
  const task = store.create('owner', 'desktop', 'request', 'project', '/preview notes.md');
  const { run } = store.claim('owner', 'project', device.id, Date.now(), 45_000)!;
  const module = new URL('../device/ledger.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { DeviceLedger } from ${JSON.stringify(module)};
    const ledger = new DeviceLedger(process.argv[1]);
    ledger.begin('workspace', process.argv[2]);
    console.log('recorded');
    process.on('SIGTERM', () => ledger.close());
    setInterval(() => {}, 1000);
  `, path, run.id], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  try {
    const [ready] = await Promise.race([
      once(child.stdout!, 'data'), exit.then(() => { throw new Error('Device exited before writing its execution record'); }),
    ]);
    assert.equal(String(ready).trim(), 'recorded');
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
  const ledger = new DeviceLedger(path);
  const server = routerServer(store, { owner: 'owner', token: 'admin' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = new URL('http://127.0.0.1:' + address.port);
  const rotation = store.registerDevice('owner', 'Replacement device', 'project');
  const client = new DeviceClient(url, device.token, dir, ledger, undefined, undefined, 'workspace');
  const rotated = new DeviceClient(url, rotation.token, dir, ledger, undefined, undefined, 'workspace');
  try {
    const signal = AbortSignal.timeout(2000);
    assert.equal(await rotated.runOnce(signal), false);
    assert.equal(store.get('owner', task.id)?.status, 'running');
    assert.equal(await client.runOnce(signal), false);
    assert.equal(await client.runOnce(signal), false);
    assert.equal(store.get('owner', task.id)?.status, 'waiting_user');
    assert.equal(store.devices('owner').find(item => item.id === device.id)?.interruptedRunId, run.id);
    assert.equal(store.events('owner', 0).filter(event => event.type === 'run.device_interrupted').length, 1);
    assert.equal(ledger.clearExecution('workspace', 'wrong-run'), false);
    assert.equal(ledger.clearExecution('workspace', run.id), true);
    assert.equal(await client.runOnce(signal), false);
    assert.equal(store.devices('owner').find(item => item.id === device.id)?.interruptedRunId, null);
    ledger.begin('workspace', 'second-run');
    ledger.complete('workspace', 'scope', 'second-run', { status: 'succeeded', result: 'Completed' });
    assert.equal(ledger.interrupted('workspace'), undefined);
    assert.equal(ledger.next('scope')?.outcome.result, 'Completed');
  } finally {
    client.close();
    rotated.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    ledger.close();
  }
});
