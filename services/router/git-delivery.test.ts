import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareGitSnapshots, deliverGitPatch, publishGitDelivery } from './application/git-delivery.ts';

test('delivers the reviewed patch once on a separate branch without changing the working tree or index', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'blazar-delivery-test-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trimEnd();
    const file = join(repository, 'file.txt');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Blazar Test');
    git('config', 'user.email', 'blazar@example.invalid');
    await writeFile(file, 'base\n');
    git('add', 'file.txt');
    git('commit', '-qm', 'Base');
    const baseCommit = git('rev-parse', 'HEAD');
    await writeFile(file, 'reviewed change\n');
    await writeFile(join(repository, 'new.txt'), 'new file\n');
    git('add', 'new.txt');
    const patch = git('diff', 'HEAD') + '\n';
    await writeFile(file, 'local edit\n');
    git('reset', '-q', 'HEAD', '--', 'new.txt');
    const originalStatus = git('status', '--short');
    const request = {
      repository, branch: 'blazar/delivery', artifactId: 'review',
      content: Buffer.from(JSON.stringify({ version: 1, baseCommit, patch })),
      assertCurrent() {}, record() {},
    };
    const result = await deliverGitPatch(request);
    assert.deepEqual(await deliverGitPatch(request), result);
    assert.equal(git('rev-parse', 'HEAD'), baseCommit);
    assert.equal(git('status', '--short'), originalStatus);
    assert.equal(await readFile(file, 'utf8'), 'local edit\n');
    assert.equal(git('show', result.commit + ':file.txt'), 'reviewed change');
    assert.equal(git('show', result.commit + ':new.txt'), 'new file');
    assert.match(await compareGitSnapshots(repository,
      Buffer.from(JSON.stringify({ version: 1, baseCommit, patch: '' })), request.content), /\+reviewed change/);
    const remote = join(repository, '.git', 'test-remote');
    git('init', '--bare', remote);
    git('remote', 'add', 'test', remote);
    const pushed = await publishGitDelivery({ repository, ...result, remote: 'test', assertCurrent() {}, record() {} });
    assert.equal(pushed.commit, result.commit);
    assert.equal(git('ls-remote', 'test', 'refs/heads/' + result.branch).split('\t')[0], result.commit);
    git('branch', 'occupied', 'main');
    await assert.rejects(deliverGitPatch({ ...request, branch: 'occupied' }), /already exists/);
    await assert.rejects(deliverGitPatch({
      ...request, branch: 'stale',
      assertCurrent() { throw new Error('stale'); },
    }));
    assert.equal(git('branch', '--list', 'stale'), '');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
