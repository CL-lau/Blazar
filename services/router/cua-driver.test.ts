import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';
import { cuaDesktop } from '../../packages/computer-use/cua.ts';
import { clickApp, observeApp, observeWindowWithImage, setAppText } from '../../packages/computer-use/observe.ts';

test('CUA verifies window-scoped edits before a workflow can advance', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'blazar-cua-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'driver.cjs');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const [command, tool, input, socketOption, socket] = process.argv.slice(2);
const args = JSON.parse(input);
const pid = ${process.pid};
if (command !== 'call' || socketOption !== '--socket' || socket !== require('node:path').join(process.cwd(), 'cua.sock')) process.exit(2);
let response;
if (tool === 'list_apps') response = { apps: [
  { name: 'Notes', bundle_id: 'com.example.notes', pid, running: true },
  { name: 'Notes', bundle_id: 'com.other.notes', pid: pid + 1, running: true }
] };
if (tool === 'list_windows' && args.pid === pid && args.on_screen_only) response = { windows: [
  { window_id: 30, pid, title: 'Draft', is_on_screen: true },
  { window_id: 31, pid: pid + 1, title: 'Other app', is_on_screen: true }
] };
if (tool === 'check_permissions' && args.prompt === false) response = { accessibility: true, screen_recording: true };
if (tool === 'get_window_state' && args.pid === pid && args.window_id === 30) {
  response = { pid, window_id: 30 };
  if (args.include_accessibility_tree === false) {
    fs.writeFileSync(args.screenshot_out_file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4sAAAAASUVORK5CYII=', 'base64'));
    response.screenshot_file_path = args.screenshot_out_file;
  } else if (args.include_screenshot === false && args.tree_format === 'elements') {
    if (args.session) fs.writeFileSync('action-session', args.session);
    response.elements = [{ element_index: 0, role: 'AXWindow', label: 'Draft' },
      { element_index: 1, parent_index: 0, role: 'AXStaticText', label: fs.existsSync('clicked') ? 'Saved' : 'Project notes' },
      { element_index: 2, parent_index: 0, role: 'AXButton', label: 'Save', actions:['AXPress'],
        element_token: args.session ? 's00000003:2' : 's00000002:2' },
      { element_index: 3, parent_index: 0, role: 'AXTextField', title: 'Title',
        value: fs.existsSync('edited') ? fs.readFileSync('edited','utf8') : 'Old title',
        element_token: args.session ? 's00000003:3' : 's00000002:3' },
      { element_index: 4, parent_index: 0, role: 'AXTextField', subrole: 'AXSecureTextField',
        title: 'Password', label: 'Password', element_token: 's00000003:4' }];
  }
}
if (tool === 'click' && args.session === fs.readFileSync('action-session','utf8') && args.element_token === 's00000003:2' &&
    args.action === 'press' && args.delivery_mode === 'background' && fs.existsSync('approved')) {
  fs.writeFileSync('clicked','yes');
  response = { path: 'ax' };
}
if (tool === 'set_value' && args.session === fs.readFileSync('action-session','utf8') && args.element_token === 's00000003:3') {
  fs.writeFileSync('edited', args.value);
  response = { success: true };
}
if (tool === 'end_session' && args.session === fs.readFileSync('action-session','utf8')) {
  fs.writeFileSync('ended',args.session);
  response = { ended: true };
}
if (!response) process.exit(2);
console.log(JSON.stringify(response, null, 2));
console.log('Human-readable output');
`, { mode: 0o700 });
  const config = { executable, driver: cuaDesktop(executable, join(root, 'cua.sock')), apps: new Map([['notes', 'bundle:com.example.notes']]),
    visualApps: new Set(['notes']), textFields: new Map([['notes', new Set(['Title'])]]), buttons: new Map([['notes', new Set(['Save'])]]) };
  const signal = AbortSignal.timeout(8_000);
  const windows = JSON.parse(await observeApp(config, root, '/observe notes --windows-json', signal));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'w-30');
  const result = await observeWindowWithImage(config, root, 'notes', 'w-30', windows[0].identity, signal);
  assert.match(result.text, /AXStaticText: Project notes/);
  assert.equal(result.image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const goal = '/click notes --window w-30 --instance ' + windows[0].identity + ' Save';
  const pressed = await clickApp(config, root, goal, signal, async () => async () => {
    writeFileSync(join(root, 'approved'), '');
    return true;
  }, 'Saved');
  assert.match(pressed, /AXStaticText: Saved/);
  assert.equal(readFileSync(join(root, 'ended'), 'utf8'), readFileSync(join(root, 'action-session'), 'utf8'));
  const snapshot = await config.driver.snapshot(root, 'bundle:com.example.notes', signal, 'w-30', true);
  assert(snapshot.actionSession);
  const children = snapshot.tree.children[0].children;
  assert.deepEqual(children[2].editableText, { label: 'Title', reference: 's00000003:3', value: 'Old title' });
  assert.equal(children[3].editableText, undefined);
  await config.driver.releaseActionSession!(root, snapshot.actionSession);
  const target = { alias: 'notes', windowId: 'w-30', identity: windows[0].identity, label: 'Title', value: 'New title' };
  await assert.rejects(setAppText(config, root, { ...target, label: 'Password' }, signal, async () => {
    assert.fail('A blocked field cannot request approval');
  }), /configured desktop text field/);
  await assert.rejects(setAppText(config, root, target, signal, async () => undefined), /was not approved/);
  assert.equal(await setAppText(config, root, target, signal, async summary => {
    assert.match(summary, /Set "Title".*"New title"/);
    return async () => true;
  }), 'Verified text in "Title".');
  assert.equal(readFileSync(join(root, 'edited'), 'utf8'), 'New title');
  assert.equal(readFileSync(join(root, 'ended'), 'utf8'), readFileSync(join(root, 'action-session'), 'utf8'));

  rmSync(join(root, 'clicked'));
  rmSync(join(root, 'approved'));
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const device = store.registerDevice('owner', 'Mac fixture', 'project');
  const phone = store.redeemPairing(store.createPairing('owner', Date.now()).code, 'Phone fixture', Date.now())!;
  const server = routerServer(store, { owner: 'owner', token: 'admin' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = new URL('http://127.0.0.1:' + address.port);
  const client = new DeviceClient(base, device.token, root, ledger, undefined, config);
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    store.close();
  });
  const live = AbortSignal.timeout(15_000);
  const post = (path: string, token: string, key: string, data: object) => fetch(new URL(path, base), {
    method: 'POST', signal: live,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(data),
  });
  assert.equal(await client.runOnce(live), false);
  const app = { alias: 'notes', deviceId: device.id };
  const windowFrom = { step: 'windows', title: 'Draft' };
  const workflow = await post('/v1/workflows', 'admin', 'text-workflow', {
    workspace: 'project', steps: [
      { key: 'windows', goal: 'Find the draft', needs: [], action: { ...app, kind: 'desktop.observe', mode: 'windows' } },
      { key: 'edit', goal: 'Edit the title', needs: ['windows'], action: {
        ...app, kind: 'desktop.write', field: 'Title', value: 'Workflow title', windowFrom,
      } },
      { key: 'save', goal: 'Save the draft', needs: ['windows', 'edit'], action: {
        ...app, kind: 'desktop.click', button: 'Save', expectedText: 'Saved', windowFrom,
      } },
    ],
  });
  assert.equal(workflow.status, 202, await workflow.clone().text());
  const { steps } = await workflow.json();
  assert.equal(await client.runOnce(live), true);

  async function runApproved(taskId: string, check: () => void) {
    const run = client.runOnce(live);
    void run.catch(() => {});
    let approval;
    while (!(approval = store.snapshot('owner').approvals.find(item => item.taskId === taskId))) {
      live.throwIfAborted();
      assert.notEqual(store.get('owner', taskId)?.status, 'failed');
      await delay(20, undefined, { signal: live });
    }
    check();
    const approved = await post('/v1/tasks/' + taskId + '/commands', phone.token, taskId, {
      action: 'approve', expectedVersion: 1, approvalId: approval.id,
    });
    assert.equal(approved.status, 200);
    assert.equal(await run, true);
    assert.equal(store.get('owner', taskId)?.status, 'succeeded');
  }

  await runApproved(steps[1].taskId, () => {
    assert.equal(readFileSync(join(root, 'edited'), 'utf8'), 'New title');
    assert.equal(store.get('owner', steps[2].taskId)?.status, 'waiting_dependency');
  });
  assert.equal(readFileSync(join(root, 'edited'), 'utf8'), 'Workflow title');
  await runApproved(steps[2].taskId, () => {
    writeFileSync(join(root, 'approved'), '');
  });
  assert.equal(readFileSync(join(root, 'clicked'), 'utf8'), 'yes');

});
