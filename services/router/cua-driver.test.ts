import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cuaDesktop } from '../../packages/computer-use/cua.ts';
import { observeApp, observeWindowWithImage } from '../../packages/computer-use/observe.ts';

test('CUA scopes hybrid observations to the configured local process and window', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'blazar-cua-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'driver.cjs');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const [command, tool, input] = process.argv.slice(2);
const args = JSON.parse(input);
const pid = ${process.pid};
if (command !== 'call') process.exit(2);
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
    response.elements = [{ element_index: 0, role: 'AXWindow', label: 'Draft' },
      { element_index: 1, parent_index: 0, role: 'AXStaticText', label: 'Project notes' }];
  }
}
if (!response) process.exit(2);
console.log(JSON.stringify(response, null, 2));
console.log('Human-readable output');
`, { mode: 0o700 });
  const config = { executable, driver: cuaDesktop(executable), apps: new Map([['notes', 'bundle:com.example.notes']]),
    visualApps: new Set(['notes']) };
  const signal = AbortSignal.timeout(8_000);
  const windows = JSON.parse(await observeApp(config, root, '/observe notes --windows-json', signal));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'w-30');
  const result = await observeWindowWithImage(config, root, 'notes', 'w-30', windows[0].identity, signal);
  assert.match(result.text, /AXStaticText: Project notes/);
  assert.equal(result.image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
