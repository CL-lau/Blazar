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
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('isolated Worker runs keep their changes in independent retained worktrees', async t => {
  const state = await realpath(await mkdtemp(join(tmpdir(), 'blazar-git-runs-')));
  t.after(() => rm(state, { force: true, recursive: true }));
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
    args: ['-e', `
      const fs = require('node:fs');
      const { input } = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (fs.readFileSync('notes.txt', 'utf8') !== 'Committed source') process.exit(1);
      fs.writeFileSync('notes.txt', input.goal);
      process.stdout.write(JSON.stringify({ version: 1, type: 'completed', result: input.goal }) + '\\n');
    `],
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
  const ledger = new DeviceLedger(':memory:');
  const device = store.registerDevice('owner', 'Git fixture', 'project');
  const server = routerServer(store, { owner: 'owner', token: 'fixture' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new DeviceClient(new URL('http://127.0.0.1:' + address.port), device.token,
    repository, ledger, worker, undefined, repository, await gitRunWorktrees(repository, state, true));
  t.after(async () => {
    client.close();
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    ledger.close();
    store.close();
  });
  store.createWorkflow('owner', 'git-handoff', 'project', [
    { key: 'draft', goal: 'Draft content', needs: [], workerCapability: 'git-worktree' },
    { key: 'review', goal: 'Review changes', needs: ['draft'] },
  ]);
  assert.equal(await client.runOnce(AbortSignal.timeout(5_000)), true);
  const receiver = store.claim('owner', 'project', 'reviewer', Date.now(), 45_000)!;
  assert.equal(receiver.task.goal, 'Review changes');
  assert.equal(receiver.predecessors[0].result, 'Draft content');
  assert.equal(receiver.predecessors[0].artifact?.name, 'git-changes.json');
  const received = JSON.parse(receiver.predecessors[0].artifact!.excerpt);
  assert.deepEqual(received.trackedFiles, ['M\tnotes.txt']);
  assert.match(received.patch, /-Committed source[\s\S]*\+Draft content/);
  const patched = await gitRunWorktrees(repository, state, true);
  await writeFile(join(first, 'notes.txt'), 'x'.repeat(70_000));
  const oversized = JSON.parse((await patched.artifact(firstId, AbortSignal.timeout(5_000))).text);
  assert.equal(oversized.patch, undefined);
  assert.equal(oversized.patchOmitted, 'size_limit');

});
