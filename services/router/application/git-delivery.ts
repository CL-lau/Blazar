import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { RequestError } from '../protocol/request.ts';

const run = promisify(execFile);
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function deliverGitPatch({
  repository, branch, artifactId, content, assertCurrent, record,
}: {
  repository: string;
  branch: string;
  artifactId: string;
  content: Uint8Array;
  assertCurrent: () => void;
  record: (result: { branch: string; commit: string }) => void;
}) {
  if (!isAbsolute(repository) || !/^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(branch)) {
    throw new RequestError(400, 'Enter an absolute repository path and a valid new branch name');
  }
  let report;
  try { report = JSON.parse(Buffer.from(content).toString('utf8')); } catch { /* Invalid artifact. */ }
  if (report?.version !== 1 || typeof report.baseCommit !== 'string' || !objectId.test(report.baseCommit) ||
      typeof report.patch !== 'string' || !report.patch.trim()) {
    throw new RequestError(409, 'This result does not contain a complete Git patch');
  }

  const temp = await mkdtemp(join(tmpdir(), 'blazar-delivery-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_INDEX_FILE = join(temp, 'index');
  env.GIT_NO_REPLACE_OBJECTS = '1';
  const options = { cwd: repository, env, timeout: 10_000, maxBuffer: 1024 * 1024 };
  const args = (command: string[]) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...command];
  const git = async (...command: string[]) => (await run('git', args(command), options)).stdout.trim();
  const ref = 'refs/heads/' + branch;
  const message = 'Deliver reviewed Blazar changes\n\nBlazar-Artifact: ' + artifactId;
  try {
    options.cwd = await git('rev-parse', '--show-toplevel');
    await git('check-ref-format', ref);
    // Require this repository to contain the exact reviewed base.
    await git('cat-file', '-e', report.baseCommit + '^{commit}');
    const patchFile = join(temp, 'review.patch');
    await writeFile(patchFile, report.patch, { mode: 0o600 });
    await git('read-tree', report.baseCommit);
    await git('apply', '--cached', '--binary', '--whitespace=nowarn', '--', patchFile);
    const tree = await git('write-tree');
    if (tree === await git('rev-parse', report.baseCommit + '^{tree}')) {
      throw new RequestError(409, 'The reviewed patch does not change the repository');
    }
    const existing = await git('for-each-ref', '--format=%(refname) %(objectname)', ref);
    const head = existing.split('\n').find(line => line.startsWith(ref + ' '))?.slice(ref.length + 1);
    if (head) {
      const matching = await git('show', '-s', '--format=%T%n%P%n%B', head);
      if (matching !== [tree, report.baseCommit, message].join('\n')) {
        throw new RequestError(409, 'The branch already exists. Choose a new branch name.');
      }
      assertCurrent();
      const result = { branch, commit: head };
      record(result);
      return result;
    }
    const worktrees = await git('worktree', 'list', '--porcelain');
    if (worktrees.split('\n').includes('branch ' + ref)) {
      throw new RequestError(409, 'Choose a branch that is not checked out');
    }
    const commit = await git('commit-tree', tree, '-p', report.baseCommit, '-m', message);
    assertCurrent();
    // Keep the version check and atomic ref creation in one Router event-loop turn.
    execFileSync('git', args(['update-ref', ref, commit, '0'.repeat(commit.length)]), options);
    const result = { branch, commit };
    record(result);
    return result;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(409, 'Git delivery failed. Check the repository path, reviewed base, branch name, and Git author configuration.');
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function publishGitDelivery({
  repository, branch, commit, remote, base, title, assertCurrent, record,
}: {
  repository: string; branch: string; commit: string; remote: string; base?: string; title?: string;
  assertCurrent: () => void; record: (result: { branch: string; commit: string; remote: string; url?: string }) => void;
}) {
  const safeRef = /^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/;
  if (!isAbsolute(repository) || !safeRef.test(branch) || !safeRef.test(remote) || !objectId.test(commit) ||
      (base && (!safeRef.test(base) || base === branch))) {
    throw new RequestError(400, 'Invalid Git publication target');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_NO_REPLACE_OBJECTS: '1' });
  const options = { cwd: repository, env, timeout: 30_000, maxBuffer: 1024 * 1024 };
  const git = async (...args: string[]) => (await run('git', args, options)).stdout.trim();
  const ref = 'refs/heads/' + branch;
  const result = { branch, commit, remote };
  try {
    if (await git('rev-parse', '--verify', ref) !== commit) {
      throw new RequestError(409, 'The local branch no longer points to the delivered commit');
    }
    const pushUrls = (await git('remote', 'get-url', '--push', '--all', '--', remote)).split('\n');
    if (pushUrls.length !== 1) throw new RequestError(400, 'Select a remote with one push URL');
    const [remoteUrl] = pushUrls;
    if (!base) {
      assertCurrent();
      await git('push', '--no-follow-tags', '--no-mirror', '--recurse-submodules=no', '--', remote, commit + ':' + ref);
      record(result);
      return result;
    }
    const project = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl)?.[1];
    if (!project) throw new RequestError(400, 'Pull requests require a GitHub remote');
    const refs = await git('ls-remote', '--refs', '--', remoteUrl, ref);
    if (refs.split('\t')[0] !== commit) throw new RequestError(409, 'Push the delivered commit before opening a pull request');
    const gh = async (...args: string[]) => (await run('gh', args, options)).stdout.trim();
    assertCurrent();
    const list = async () => JSON.parse(await gh('pr', 'list', '--repo', project, '--head', branch,
      '--base', base, '--state', 'open', '--json', 'url,headRefOid,isCrossRepository'))
      .find((item: { headRefOid: string; isCrossRepository: boolean }) => item.headRefOid === commit && !item.isCrossRepository)?.url;
    let url = await list();
    if (!url) {
      try {
        url = await gh('pr', 'create', '--repo', project, '--head', branch,
          '--base', base, '--title', title ?? 'Reviewed Blazar changes', '--body', 'Delivered from a reviewed Blazar task.');
      } catch (error) {
        url = await list();
        if (!url) throw error;
      }
    }
    if (typeof url !== 'string' || !url.startsWith('https://github.com/' + project + '/pull/')) {
      throw new RequestError(409, 'GitHub did not return a pull request URL');
    }
    record({ ...result, url });
    return { ...result, url };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(409, base ? 'Could not open a pull request. Check GitHub CLI authentication and the target branch.'
      : 'Push failed. Check the remote, credentials, and whether the remote branch has diverged.');
  }
}

export async function compareGitSnapshots(repository: string, before: Uint8Array, after: Uint8Array) {
  if (!isAbsolute(repository)) throw new RequestError(400, 'Enter an absolute repository path');
  const temp = await mkdtemp(join(tmpdir(), 'blazar-compare-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.GIT_NO_REPLACE_OBJECTS = '1';
    const root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: repository, env, timeout: 10_000 })).stdout.trim();
    const tree = async (bytes: Uint8Array, name: string) => {
      const report = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (report?.version !== 1 || typeof report.baseCommit !== 'string' || !objectId.test(report.baseCommit) || typeof report.patch !== 'string') {
        throw new RequestError(409, 'Both runs must have a complete Git patch');
      }
      const options = { cwd: root, env: { ...env, GIT_INDEX_FILE: join(temp, name + '.index') }, timeout: 10_000 };
      await run('git', ['read-tree', report.baseCommit + '^{tree}'], options);
      if (report.patch) {
        const patch = join(temp, name + '.patch');
        await writeFile(patch, report.patch, { mode: 0o600 });
        await run('git', ['apply', '--cached', '--binary', '--whitespace=nowarn', '--', patch], options);
      }
      return (await run('git', ['write-tree'], options)).stdout.trim();
    };
    const oldTree = await tree(before, 'previous');
    const newTree = await tree(after, 'current');
    const { stdout } = await run('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary',
      oldTree, newTree, '--'], { cwd: root, env, timeout: 10_000, maxBuffer: 256_000 });
    return stdout;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(409, 'Could not compare these snapshots. Check the local repository and patch size.');
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
