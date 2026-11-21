import { lockDatabaseFile } from '../../packages/storage/exclusive.ts';
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
if (process.argv[2] === 'list-windows') {
  console.log(JSON.stringify({ok:true,command:'list-windows',data:[
    {id:'w-10',app_name:'Calculator',title:'Scientific · Calculator',visible:true,accessible:true},
    {id:'w-11',app_name:'Other',title:'Other workspace',visible:true,accessible:true},
  ]}));
  process.exit(0);
}
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
  const { id: computer, token } = store.registerDevice('owner', 'Computer', 'work');
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
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), false);
  const second = store.registerDevice('owner', 'Second computer', 'work');
  store.recordDeviceActivity(second.id, Date.now(), 'computer.observe');
  store.recordDesktopApps(second.id, ['calculator']);
  const deskTask = await fetch(new URL('/v1/events', 'http://127.0.0.1:' + address.port), {
    method: 'POST', headers: {
      Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': 'targeted-observation',
    },
    body: JSON.stringify({ workspace: 'work', text: '/observe calculator', desktopDevice: computer }),
  });
  assert.equal(deskTask.status, 202);
  const task = await deskTask.json();
  assert.equal(store.claim('owner', 'work', second.id, Date.now(), 45_000, '/observe ',
    '', undefined, undefined, ['calculator']), undefined);
  const denied = store.create('owner', 'desktop', 'unconfigured', 'work', '/observe other');
  const preview = store.create('owner', 'desktop', 'preview', 'work', '/preview notes.md');
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), false);
  const state = await fetch(new URL('/v1/state', 'http://127.0.0.1:' + address.port), {
    headers: { Authorization: 'Bearer admin' },
  });
  assert.deepEqual((await state.json()).desktopTargets, [
    { workspace: 'work', deviceId: computer, deviceName: 'Computer', alias: 'calculator' },
    { workspace: 'work', deviceId: second.id, deviceName: 'Second computer', alias: 'calculator' },
  ]);
  const { artifacts } = store.snapshot('owner');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].taskId, task.id);
  const file = store.artifact('owner', String(artifacts[0].id))!;
  assert.equal(Buffer.from(file.content).toString(), 'window: Calculator\n  button: Add');
  const windows = store.create('owner', 'desktop', 'windows', 'work', '/observe calculator --windows-json', computer);
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  assert.deepEqual(JSON.parse(store.get('owner', windows.id)?.result ?? ''), [
    { id: 'w-10', title: 'Scientific · Calculator', accessible: true },
  ]);
  store.updateDeviceReadiness(Date.now());
  assert.equal(store.get('owner', denied.id)?.status, 'waiting_device');
  assert.equal(store.get('owner', preview.id)?.status, 'waiting_device');
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
if (op === 'list-windows') {
  console.log(JSON.stringify({ok:true,command:op,data:[{
    id:'w-10',app_name:'Calculator',title:'Calculator',visible:true,accessible:true,
    process_instance:fs.existsSync('replaced')?'replacement':'original'
  }]}));
} else if (op === 'snapshot') {
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
  const lockPath = join(directory, 'desktop-lock.sqlite');
  const config = observationConfig({
    BLAZAR_COMPUTER_DRIVER: driver, BLAZAR_COMPUTER_APPS: '{"calc":"Calculator"}',
    BLAZAR_COMPUTER_BUTTONS: '{"calc":["Add"]}',
  }, lockPath);
  const signal = AbortSignal.timeout(5_000);
  const release = lockDatabaseFile(lockPath, 'Desktop already occupied');
  try {
    await assert.rejects(clickApp(config, directory, '/click calc Add', signal, async () => {
      assert.fail('A competing action must not request approval');
    }), /using the desktop/);
  } finally {
    release();
  }
  await assert.rejects(clickApp(config, directory, '/click calc Delete', signal, async () => undefined), /configured/);
  await assert.rejects(clickApp(config, directory, '/click calc Add', signal, async () => {
    writeFileSync(join(directory, 'changed'), '');
    return async () => { assert.fail('Changed windows must not consume approval'); };
  }), /changed after review/);
  rmSync(join(directory, 'changed'));
  await assert.rejects(clickApp(config, directory, '/click calc --window w-10 Add', signal, async summary => {
    assert.match(summary, /window w-10/);
    writeFileSync(join(directory, 'replaced'), '');
    return async () => { assert.fail('A replacement process must not consume approval'); };
  }), /changed after review/);
  rmSync(join(directory, 'replaced'));
  const result = await clickApp(config, directory, '/click calc --window w-10 Add', signal, async summary => {
    assert.match(summary, /Click "Add" in Calculator/);
    lockDatabaseFile(lockPath, 'Desktop locked while awaiting review')();
    writeFileSync(join(directory, 'reviewed'), '');
    return async () => {
      assert.throws(() => lockDatabaseFile(lockPath, 'Desktop busy'), /Desktop busy/);
      writeFileSync(join(directory, 'consumed'), '');
      return true;
    };
  });
  assert.match(result, /Done/);
  assert.equal(readFileSync(join(directory, 'clicked'), 'utf8'), 'yes');
});

test('selected window must belong to the configured application and be accessible', async t => {
  const { observeApp } = await import('../../packages/computer-use/observe.ts');
  const root = mkdtempSync(join(tmpdir(), 'blazar-window-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const driver = join(root, 'driver.cjs');
  writeFileSync(driver, `#!${process.execPath}
const args = process.argv.slice(2);
const send = data => console.log(JSON.stringify({ok:true,command:args[0],data}));
if (args.join(' ') === 'list-windows --app Calculator') send([
  {id:'w-10',app_name:'Calculator',title:'Arithmetic',visible:true,accessible:true},
  {id:'w-11',app_name:'Other Application',title:'Other app data',visible:true,accessible:true},
  {id:'w-12',app_name:'Calculator',title:'Second window',visible:true,accessible:false}
]);
else if (args.join(' ') === 'snapshot --app Calculator -i --window-id w-10') send({tree:{role:'window',name:'Arithmetic'}});
else process.exit(2);
`, { mode: 0o700 });
  const config = observationConfig({ BLAZAR_COMPUTER_DRIVER: driver, BLAZAR_COMPUTER_APPS: '{"calculator":"Calculator"}' });
  const signal = AbortSignal.timeout(3000);
  const list = await observeApp(config, root, '/observe calculator --windows', signal);
  assert.match(list, /w-10 · Arithmetic/);
  assert.doesNotMatch(list, /Other app/);
  assert.equal(await observeApp(config, root, '/observe calculator --window w-10', signal), 'window: Arithmetic');
  await assert.rejects(observeApp(config, root, '/observe calculator --window w-11', signal), /inaccessible/);
  await assert.rejects(observeApp(config, root, '/observe calculator --window w-12', signal), /inaccessible/);
});
