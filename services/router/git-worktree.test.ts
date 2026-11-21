import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitRunWorktrees, inspectRunWorktree } from '../device/execution/git-worktree.ts';
import { executeWorker } from '../device/execution/worker.ts';
import { DeviceClient } from '../device/client.ts';
import { lockWorkspace } from '../device/workspace.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('isolated Worker runs keep their changes in independent retained worktrees', async t => {
  const state = await realpath(await mkdtemp(join(tmpdir(), 'blazar-git-runs-')));
  let stopServer: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stopServer?.();
    await rm(state, { force: true, recursive: true });
  });
  const repository = join(state, 'project');
  await mkdir(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  git('init');
  const notes = join(repository, 'notes.txt');
  await writeFile(notes, 'Committed source');
  git('add', 'notes.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  await writeFile(notes, 'Uncommitted user edit');
  const worktrees = await gitRunWorktrees(repository, state);
  const { prepare, artifact } = worktrees;
  const firstId = randomUUID();
  const [first, second] = await Promise.all([prepare(firstId), prepare(randomUUID())]);
  const worker = {
    label: 'Writing fixture', protocol: 'jsonl' as const, executable: process.execPath,
    args: ['-e', String.raw`
      const fs = require('node:fs');
      const { input } = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (fs.readFileSync('notes.txt', 'utf8') !== 'Committed source') process.exit(1);
      fs.writeFileSync('notes.txt', input.goal);
      function finish() {
        process.stdout.write(JSON.stringify({ version: 1, type: 'completed', result: input.goal }) + '\n');
      }
      if (!input.goal.startsWith('Parallel ')) finish();
      else {
        const sibling = input.goal === 'Parallel A' ? 'Parallel B' : 'Parallel A';
        const path = require('node:path');
        fs.writeFileSync(path.join(process.argv[1], input.goal), process.cwd());
        const timer = setInterval(() => {
          if (!fs.existsSync(path.join(process.argv[1], sibling))) return;
          clearInterval(timer);
          finish();
        }, 10);
      }
    `, state],
  };
  const run = async (root: string, goal: string) => {
    const stop = new AbortController();
    return executeWorker({
      root, scope: 'test', workspaceIdentity: root,
      ledger: { takeSession: () => undefined },
      post: async () => { throw new Error('Unexpected progress'); },
      approve: async () => undefined, consumeApproval: async () => false,
    }, worker, 'run/', 'task', { goal, instructions: [], predecessors: [] }, stop, AbortSignal.timeout(5_000));
  };
  await Promise.all([run(first, 'First edit'), run(second, 'Second edit')]);
  assert.equal(await readFile(notes, 'utf8'), 'Uncommitted user edit');
  assert.equal(await readFile(join(first, 'notes.txt'), 'utf8'), 'First edit');
  assert.equal(await readFile(join(second, 'notes.txt'), 'utf8'), 'Second edit');
  const initial = await inspectRunWorktree(repository, join(state, 'run-worktrees'), firstId);
  assert.equal(initial.state, 'ready');
  assert(initial.state === 'ready');
  assert.deepEqual(initial.changes, [' M notes.txt']);
  assert.deepEqual(initial.commits, []);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c',
    'commit.gpgsign=false', 'commit', '-am', 'Worker edit'], { cwd: first, stdio: 'pipe' });
  await writeFile(join(first, 'untracked.txt'), 'Retained output');
  const changed = await inspectRunWorktree(repository, join(state, 'run-worktrees'), firstId);
  assert(changed.state === 'ready');
  assert.equal(changed.baseCommit, initial.head);
  assert.deepEqual(changed.commits, [changed.head]);
  assert.deepEqual(changed.changes, ['?? untracked.txt']);
  assert.deepEqual(await inspectRunWorktree(repository, join(state, 'run-worktrees'), randomUUID()), { state: 'missing' });
  const report = await artifact(firstId, AbortSignal.timeout(5_000));
  assert.equal(report.name, 'git-changes.json');
  assert.deepEqual(JSON.parse(report.text), {
    version: 1, baseCommit: initial.head, head: changed.head, commits: [changed.head],
    trackedFiles: ['M\tnotes.txt'], changes: ['?? untracked.txt'],
  });
  await assert.rejects(prepare(firstId), /Unable to prepare the run Git worktree/);

  const store = new TaskStore(':memory:');
  const devices = ['Git fixture A', 'Git fixture B'].map(label => {
    const device = store.registerDevice('owner', label, 'project');
    return { device, lock: lockWorkspace(repository, state, device.token),
      ledger: new DeviceLedger(join(state, 'device-ledger.sqlite')) };
  });
  const server = routerServer(store, { owner: 'owner', token: 'fixture' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const patchedWorktrees = await gitRunWorktrees(repository, state, true);
  const base = new URL('http://127.0.0.1:' + address.port);
  const clients = devices.map(({ device, ledger, lock }) =>
    new DeviceClient(base, device.token, lock.root, ledger, worker, undefined, lock.identity, patchedWorktrees));
  stopServer = async () => {
    for (const client of clients) client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const { ledger, lock } of devices) {
      ledger.close();
      lock.release();
    }
    store.close();
  };
  store.createWorkflow('owner', 'git-handoff', 'project', [
    { key: 'a', goal: 'Parallel A', needs: [], workerCapability: 'git-worktree' },
    { key: 'b', goal: 'Parallel B', needs: [], workerCapability: 'git-worktree' },
    { key: 'review', goal: 'Review changes', needs: ['a', 'b'] },
  ]);
  assert.deepEqual(await Promise.all(clients.map(client => client.runOnce(AbortSignal.timeout(5_000)))), [true, true]);
  const receiver = store.claim('owner', 'project', 'reviewer', Date.now(), 45_000)!;
  assert.equal(receiver.task.goal, 'Review changes');
  assert.deepEqual(receiver.predecessors.map(input => input.result), ['Parallel A', 'Parallel B']);
  const checkouts = [];
  for (const input of receiver.predecessors) {
    assert.equal(input.artifact?.name, 'git-changes.json');
    const received = JSON.parse(input.artifact!.excerpt);
    assert.deepEqual(received.trackedFiles, ['M\tnotes.txt']);
    assert(received.patch.includes('\n+' + input.result));
    const checkout = await readFile(join(state, input.result!), 'utf8');
    assert.equal(await readFile(join(checkout, 'notes.txt'), 'utf8'), input.result);
    checkouts.push(checkout);
  }
  assert.equal(new Set(checkouts).size, 2);
  assert.equal(await readFile(notes, 'utf8'), 'Uncommitted user edit');
  await writeFile(join(first, 'notes.txt'), 'x'.repeat(70_000));
  const oversized = JSON.parse((await patchedWorktrees.artifact(firstId, AbortSignal.timeout(5_000))).text);
  assert.equal(oversized.patch, undefined);
  assert.equal(oversized.patchOmitted, 'size_limit');
});
