import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { observationConfig } from '../../packages/computer-use/observe.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('a device observes only configured applications and stores a bounded window summary', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-observe-')));
  const executable = join(directory, 'driver.cjs');
  writeFileSync(executable, `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['snapshot','--app','Calculator','-i'])) process.exit(2);
console.log(JSON.stringify({ok:true,command:'snapshot',data:{tree:{role:'window',name:'Calculator',children:[
  {role:'button',name:'Add',value:'private value',ref_id:'@temporary'},
  {role:'secureTextField',name:'Secret title'},
]}}}));
`, { mode: 0o700 });
  const observation = observationConfig({
    BLAZAR_COMPUTER_DRIVER: executable, BLAZAR_COMPUTER_APPS: '{"calculator":"Calculator"}',
  });
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'admin' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const { token } = store.registerDevice('owner', 'Computer', 'work');
  const client = new DeviceClient(new URL('http://127.0.0.1:' + address.port), token, directory, ledger, undefined, observation);
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  store.receiveChannelMessage('owner', 'weixin', 'work', {
    id: 'chat-request', chat: 'chat', thread: 'chat-request', root: true, text: '/observe calculator',
  });
  assert.equal(store.snapshot('owner').tasks.length, 0);
  const task = store.create('owner', 'desktop', 'observation', 'work', '/observe calculator');
  const denied = store.create('owner', 'desktop', 'unconfigured', 'work', '/observe other');
  const preview = store.create('owner', 'desktop', 'preview', 'work', '/preview notes.md');
  assert.equal(await client.runOnce(AbortSignal.timeout(3_000)), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(3_000)), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(3_000)), false);
  const { artifacts } = store.snapshot('owner');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].taskId, task.id);
  const file = store.artifact('owner', String(artifacts[0].id))!;
  assert.equal(Buffer.from(file.content).toString(), 'window: Calculator\n  button: Add');
  assert.equal(store.get('owner', denied.id)?.status, 'failed');
  assert.equal(store.get('owner', preview.id)?.status, 'queued');
});

test('configured clicks use a newly observed reference after review and consume approval just before acting', async t => {
  const { clickApp } = await import('../../packages/computer-use/observe.ts');
  const { readFileSync } = await import('node:fs');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-click-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const driver = join(directory, 'driver.cjs');
  writeFileSync(driver, `#!${process.execPath}
const fs = require('node:fs');
const op = process.argv[2];
if (op === 'snapshot') {
  const clicked = fs.existsSync('clicked');
  const ref = fs.existsSync('reviewed') ? '@s2:e1' : '@s1:e1';
  console.log(JSON.stringify({ok:true,command:op,data:{window_id:'window',pid:42,tree:{
    role:'window',name:fs.existsSync('changed')?'Changed':'Calculator',children:[
      {role:'button',name:'Add',ref_id:ref,available_actions:['Click']},
      {role:'label',name:clicked?'Done':'Ready'},
    ]}}}));
} else if (op === 'click' && process.argv[3] === '@s2:e1' && fs.existsSync('consumed')) {
  fs.writeFileSync('clicked', 'yes');
  console.log(JSON.stringify({ok:true,command:op,data:{}}));
} else process.exit(2);
`, { mode: 0o700 });
  const config = observationConfig({
    BLAZAR_COMPUTER_DRIVER: driver, BLAZAR_COMPUTER_APPS: '{"calc":"Calculator"}',
    BLAZAR_COMPUTER_BUTTONS: '{"calc":["Add"]}',
  });
  const signal = AbortSignal.timeout(5_000);
  await assert.rejects(clickApp(config, directory, '/click calc Delete', signal, async () => undefined), /configured/);
  await assert.rejects(clickApp(config, directory, '/click calc Add', signal, async () => {
    writeFileSync(join(directory, 'changed'), '');
    return async () => { assert.fail('Changed windows must not consume approval'); };
  }), /changed after review/);
  rmSync(join(directory, 'changed'));
  const result = await clickApp(config, directory, '/click calc Add', signal, async summary => {
    assert.match(summary, /Click "Add" in Calculator/);
    writeFileSync(join(directory, 'reviewed'), '');
    return async () => {
      writeFileSync(join(directory, 'consumed'), '');
      return true;
    };
  });
  assert.match(result, /Done/);
  assert.equal(readFileSync(join(directory, 'clicked'), 'utf8'), 'yes');
});
