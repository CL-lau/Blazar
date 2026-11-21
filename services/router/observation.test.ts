import { lockDatabaseFile } from '../../packages/storage/exclusive.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { observationConfig, observeApp } from '../../packages/computer-use/observe.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('a device observes only configured applications and stores a bounded window summary', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-observe-')));
  const executable = join(directory, 'driver.cjs');
  writeFileSync(executable, `#!${process.execPath}
if (process.argv[2] === 'permissions') {
  console.log(JSON.stringify({ok:true,command:'permissions',data:{
    accessibility:{state:'granted'},screen_recording:{state:require('node:fs').existsSync('recording-denied')?'denied':'granted'},automation:{state:'unknown'}
  }}));
  process.exit(0);
}
if (process.argv[2] === 'screenshot') {
  if (process.argv.slice(3, 7).join(' ') !== '--app Calculator --window-id w-10') process.exit(2);
  require('node:fs').writeFileSync(process.argv[7],
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4sAAAAASUVORK5CYII=', 'base64'));
  console.log(JSON.stringify({ok:true,command:'screenshot',data:{}}));
  process.exit(0);
}
if (process.argv[2] === 'list-windows') {
  console.log(JSON.stringify({ok:true,command:'list-windows',data:[
    {id:'w-10',app_name:'Calculator',title:'Scientific · Calculator',visible:true,accessible:true,process_instance:'one'},
    {id:'w-11',app_name:'Other',title:'Other workspace',visible:true,accessible:true},
  ]}));
  process.exit(0);
}
if (![['snapshot','--app','Calculator','-i'], ['snapshot','--app','Calculator','-i','--window-id','w-10']]
    .some(args => JSON.stringify(process.argv.slice(2)) === JSON.stringify(args))) process.exit(2);
console.log(JSON.stringify({ok:true,command:'snapshot',data:{tree:{role:'window',name:'Calculator',children:[
  {role:'button',name:'Add',value:'private value',ref_id:'@temporary'},
  {role:'secureTextField',name:'Secret title'},
]}}}));
`, { mode: 0o700 });
  const observation = observationConfig({
    BLAZAR_COMPUTER_DRIVER: executable, BLAZAR_COMPUTER_APPS: '{"calculator":"Calculator"}',
    BLAZAR_COMPUTER_VISUAL_APPS: '["calculator"]',
    BLAZAR_COMPUTER_BUTTONS: '{"calculator":["Add"]}',
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
  store.recordDesktopApps(second.id, ['calculator', 'notes']);
  const misdirected = await fetch(new URL('/v1/events', 'http://127.0.0.1:' + address.port), {
    method: 'POST', headers: {
      Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': 'wrong-computer',
    },
    body: JSON.stringify({ workspace: 'work', text: '/observe notes', desktopDevice: computer }),
  });
  assert.equal(misdirected.status, 404);
  assert.equal(store.snapshot('owner').tasks.length, 0);
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
    { workspace: 'work', deviceId: computer, deviceName: 'Computer', alias: 'calculator',
      accessibility: 'granted', screenRecording: 'granted',
      controls: { alias: 'calculator', visual: true, buttons: ['Add'] } },
    { workspace: 'work', deviceId: second.id, deviceName: 'Second computer', alias: 'calculator',
      accessibility: null, screenRecording: null, controls: null },
  ]);
  const { artifacts } = store.snapshot('owner');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].taskId, task.id);
  const file = store.artifact('owner', String(artifacts[0].id))!;
  assert.equal(Buffer.from(file.content).toString(), 'window: Calculator\n  button: Add');
  const windows = store.create('owner', 'desktop', 'windows', 'work', '/observe calculator --windows-json', computer);
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  const inventory = JSON.parse(store.get('owner', windows.id)?.result ?? '');
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].id, 'w-10');
  assert.equal(inventory[0].title, 'Scientific · Calculator');
  assert.equal(inventory[0].accessible, true);
  assert.match(inventory[0].identity, /^[a-f0-9]{64}$/);
  const visual = store.create('owner', 'desktop', 'visual', 'work',
    '/observe calculator --window w-10 --instance ' + inventory[0].identity + ' --visual', computer);
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  const image = store.snapshot('owner').artifacts.find(item => item.taskId === visual.id)!;
  assert.equal(image.mime, 'image/png');
  const picture = new URL('/v1/artifacts/' + image.id, 'http://127.0.0.1:' + address.port);
  assert.equal((await fetch(picture)).status, 401);
  const pictureResponse = await fetch(picture, { headers: { Authorization: 'Bearer admin' } });
  assert.equal(pictureResponse.headers.get('Content-Type'), 'image/png');
  assert.equal(Buffer.from(await pictureResponse.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const jsonPicture = new URL(picture.href + '/image');
  assert.equal((await fetch(jsonPicture)).status, 401);
  const jsonImage = await (await fetch(jsonPicture, { headers: { Authorization: 'Bearer admin' } })).json();
  assert.equal(Buffer.from(jsonImage.png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(store.artifact('owner', String(image.id), Number(image.expires)), undefined);
  const submitVisualWorkflow = (deviceId: string, key: string) => fetch(new URL('/v1/workflows', picture), {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ workspace: 'work', steps: [
      { key: 'inventory', goal: 'List calculator windows', needs: [],
        action: { kind: 'desktop.observe', alias: 'calculator', deviceId, mode: 'windows' } },
      { key: 'capture', goal: 'Capture calculator screenshot', needs: ['inventory'],
        action: { kind: 'desktop.observe', alias: 'calculator', deviceId, mode: 'hybrid',
          windowFrom: { step: 'inventory', title: 'Scientific · Calculator' } } },
      { key: 'next', goal: 'Acknowledge completion', needs: ['capture'] },
    ] }),
  });
  assert.equal((await submitVisualWorkflow(second.id, 'unapproved-visual')).status, 404);
  const submitted = await submitVisualWorkflow(computer, 'approved-visual');
  assert.equal(submitted.status, 202);
  const { steps } = await submitted.json();
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  const blockedVisual = store.create('owner', 'desktop', 'permission-changed', 'work',
    '/observe calculator --window w-10 --instance ' + inventory[0].identity + ' --visual', computer);
  writeFileSync(join(directory, 'recording-denied'), '');
  assert.equal(await client.runOnce(AbortSignal.timeout(8_000)), true);
  assert.equal(store.get('owner', blockedVisual.id)?.status, 'failed');
  assert.match(store.get('owner', blockedVisual.id)?.result ?? '', /Screen Recording permission is required/);
  assert.equal(store.snapshot('owner').artifacts.some(item => item.taskId === blockedVisual.id), false);
  const captured = store.snapshot('owner').artifacts.find(item => item.taskId === steps[1].taskId && item.mime === 'image/png')!;
  assert.equal(captured.mime, 'image/png');
  const downstream = store.claim('owner', 'work', 'reviewer', Date.now(), 45_000, '', '/preview ')!;
  assert.equal(downstream.task.id, steps[2].taskId);
  assert.equal(downstream.predecessors[0].artifact?.name, 'application-observation.txt');
  assert.match(downstream.predecessors[0].artifact?.excerpt ?? '', /button: Add/);
  assert.equal(store.runInputArtifact(downstream.run.id, 'reviewer', String(captured.id), Date.now()), undefined);
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
      {role:'button',name:'Add',ref_id:ref,available_actions:['Click'],
        value:fs.existsSync('changed-value')?'Different':'Original'},
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
  await assert.rejects(clickApp(config, directory, '/click calc Add', signal, async () => {
    writeFileSync(join(directory, 'changed-value'), '');
    return async () => { assert.fail('A change outside the displayed summary must invalidate approval'); };
  }), /changed after review/);
  rmSync(join(directory, 'changed-value'));
  await assert.rejects(clickApp(config, directory, '/click calc --window w-10 Add', signal, async summary => {
    assert.match(summary, /window w-10/);
    writeFileSync(join(directory, 'replaced'), '');
    return async () => { assert.fail('A replacement process must not consume approval'); };
  }), /changed after review/);
  rmSync(join(directory, 'replaced'));
  const [{ identity }] = JSON.parse(await observeApp(config, directory, '/observe calc --windows-json', signal));
  assert.match(identity, /^[a-f0-9]{64}$/);
  const targetedClick = '/click calc --window w-10 --instance ' + identity + ' Add';
  writeFileSync(join(directory, 'replaced'), '');
  await assert.rejects(clickApp(config, directory, targetedClick, signal, async () => {
    assert.fail('A stale inventory must not request approval');
  }), /Refresh the window list/);
  rmSync(join(directory, 'replaced'));
  const result = await clickApp(config, directory, targetedClick, signal, async summary => {
    assert.match(summary, /Click "Add" in Calculator/);
    assert.match(summary, /Expected visible text: "Done"/);
    lockDatabaseFile(lockPath, 'Desktop locked while awaiting review')();
    writeFileSync(join(directory, 'reviewed'), '');
    return async () => {
      assert.throws(() => lockDatabaseFile(lockPath, 'Desktop busy'), /Desktop busy/);
      writeFileSync(join(directory, 'consumed'), '');
      return true;
    };
  }, 'Done');
  assert.match(result, /Done/);
  assert.equal(readFileSync(join(directory, 'clicked'), 'utf8'), 'yes');
  await assert.rejects(clickApp(config, directory, targetedClick, signal, async () => {
    assert.fail('An already visible postcondition must not request another click');
  }, 'Done'), /already visible/);
});

test('selected window must belong to the configured application and be accessible', async t => {
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

test('Router runs a window-observation workflow through phone approval and verified handoff', { timeout: 10_000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-desktop-workflow-')));
  const driver = join(directory, 'driver.cjs');
  writeFileSync(driver, `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
let data;
if (command === 'permissions') {
  data = {accessibility:{state:'granted'},screen_recording:{state:'denied'},automation:{state:'unknown'}};
} else if (command === 'list-windows') {
  data = [{id:'w-18',app_name:'Notes',title:'Draft',visible:true,accessible:true,process_instance:'fixture'}];
} else if (command === 'snapshot' && process.argv.slice(3).includes('w-18')) {
  let savedCount = 0;
  if (fs.existsSync('saved')) {
    savedCount = fs.existsSync('saved-count') ? Number(fs.readFileSync('saved-count', 'utf8')) + 1 : 1;
    fs.writeFileSync('saved-count', String(savedCount));
  }
  data = {window_id:'w-18',pid:42,tree:{role:'window',name:'Draft',children:[
    {role:'button',name:'Save',ref_id:'@save:e1',available_actions:['Click']},
    {role:'label',name:savedCount >= 3 ? 'Saved and indexed' : savedCount ? 'Saved' : 'Draft pending'}
  ]}};
} else if (command === 'click' && process.argv[3] === '@save:e1') {
  fs.writeFileSync('saved', 'yes', {flag:'wx'});
  data = {};
} else process.exit(2);
console.log(JSON.stringify({ok:true,command,data}));
`, { mode: 0o700 });
  const observation = observationConfig({
    BLAZAR_COMPUTER_DRIVER: driver, BLAZAR_COMPUTER_APPS: '{"notes":"Notes"}',
    BLAZAR_COMPUTER_BUTTONS: '{"notes":["Save"]}',
  });
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const server = routerServer(store, { owner: 'owner', token: 'admin' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = new URL('http://127.0.0.1:' + address.port);
  const device = store.registerDevice('owner', 'Notes desktop', 'project');
  const phone = store.redeemPairing(store.createPairing('owner', Date.now()).code, 'Phone fixture', Date.now())!;
  const client = new DeviceClient(base, device.token, directory, ledger, undefined, observation);
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const signal = AbortSignal.timeout(8_000);
  const post = (path: string, token: string, key: string, body: object) => fetch(new URL(path, base), {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  assert.equal(await client.runOnce(signal), false);
  const workflow = await post('/v1/workflows', phone.token, 'observe-and-click', {
    workspace: 'project', steps: [
      { key: 'windows', goal: 'List Notes windows', needs: [],
        action: { kind: 'desktop.observe', alias: 'notes', deviceId: device.id, mode: 'windows' } },
      { key: 'save', goal: 'Save the draft', needs: ['windows'],
        action: { kind: 'desktop.click', alias: 'notes', deviceId: device.id, button: 'Save', expectedText: 'Saved',
          windowFrom: { step: 'windows', title: 'Draft' } } },
      { key: 'snapshot', goal: 'Read the saved Draft window', needs: ['windows', 'save'],
        action: { kind: 'desktop.observe', alias: 'notes', deviceId: device.id, mode: 'window', expectedText: 'Saved and indexed', waitSeconds: 3,
          windowFrom: { step: 'windows', title: 'Draft' } } },
      { key: 'review', goal: 'Review the saved draft', needs: ['snapshot'] },
      { key: 'missing', goal: 'Look for Published', needs: ['windows', 'snapshot'],
        action: { kind: 'desktop.observe', alias: 'notes', deviceId: device.id, mode: 'window', expectedText: 'Published', waitSeconds: 1,
          windowFrom: { step: 'windows', title: 'Draft' } } },
      { key: 'blocked', goal: 'Review publication', needs: ['missing'] },
    ],
  });
  assert.equal(workflow.status, 202);
  const { steps } = await workflow.json() as { steps: { taskId: string }[] };
  assert.equal(await client.runOnce(signal), true);
  const clicking = client.runOnce(signal);
  void clicking.catch(() => {});
  let approval;
  while (!approval) {
    signal.throwIfAborted();
    const clickTask = store.get('owner', steps[1].taskId);
    assert.notEqual(clickTask?.status, 'failed', clickTask?.result ?? 'Click failed');
    approval = store.snapshot('owner').approvals.find(item => item.taskId === steps[1].taskId);
    if (!approval) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(store.get('owner', steps[2].taskId)?.status, 'waiting_dependency');
  assert.match(String(approval.summary), /Click "Save".*Expected visible text: "Saved"/);
  const approved = await post('/v1/tasks/' + steps[1].taskId + '/commands', phone.token, 'approve-save', {
    action: 'approve', expectedVersion: 1, approvalId: approval.id,
  });
  assert.equal(approved.status, 200);
  assert.equal(await clicking, true);
  assert.equal(store.get('owner', steps[1].taskId)?.status, 'succeeded');
  assert.equal(await client.runOnce(signal), true);
  assert.equal(store.get('owner', steps[2].taskId)?.status, 'succeeded');
  assert.equal(store.snapshot('owner').approvals.length, 0);
  const handoff = store.claim('owner', 'project', 'review-worker', Date.now(), 45_000, '', '/preview ')!;
  assert.equal(handoff.task.id, steps[3].taskId);
  assert.match(handoff.predecessors[0].artifact?.excerpt ?? '', /Saved and indexed/);
  assert.equal(await client.runOnce(signal), true);
  assert.equal(store.get('owner', steps[4].taskId)?.status, 'failed');
  assert.equal(store.get('owner', steps[5].taskId)?.status, 'waiting_dependency');
  assert(store.command('owner', steps[4].taskId, 1, { action: 'retry' }));
  const retry = store.claim('owner', 'project', device.id, Date.now(), 45_000, '/observe ')!;
  assert.equal(retry.task.id, steps[4].taskId);
  assert.equal(store.finish(retry.run.id, device.id, Date.now(), {
    status: 'succeeded', result: 'An older client reported success',
    artifact: { name: 'application-observation.txt', text: 'Saved' },
  }), true);
  assert.equal(store.get('owner', steps[4].taskId)?.status, 'failed');
  assert.equal(store.get('owner', steps[5].taskId)?.status, 'waiting_dependency');
});
