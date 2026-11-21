import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitRunWorktrees, inspectRunWorktree } from '../device/execution/git-worktree.ts';
import { executeWorker } from '../device/execution/worker.ts';

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
  const prepare = await gitRunWorktrees(repository, state);
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
  const initial = await inspectRunWorktree(repository, state, firstId);
  assert.equal(initial.state, 'ready');
  assert(initial.state === 'ready');
  assert.deepEqual(initial.changes, [' M notes.txt']);
  assert.deepEqual(initial.commits, []);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c',
    'commit.gpgsign=false', 'commit', '-am', 'Worker edit'], { cwd: first, stdio: 'pipe' });
  await writeFile(join(first, 'untracked.txt'), 'Retained output');
  const changed = await inspectRunWorktree(repository, state, firstId);
  assert(changed.state === 'ready');
  assert.equal(changed.baseCommit, initial.head);
  assert.deepEqual(changed.commits, [changed.head]);
  assert.deepEqual(changed.changes, ['?? untracked.txt']);
  assert.deepEqual(await inspectRunWorktree(repository, state, randomUUID()), { state: 'missing' });
  await assert.rejects(prepare(firstId), /Unable to prepare the run Git worktree/);
});
