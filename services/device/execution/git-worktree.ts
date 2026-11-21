import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function gitAt(workspace: string, signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return async (...args: string[]) => {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd: workspace, env, timeout: 15_000, maxBuffer: 64_000, windowsHide: true, signal });
    return stdout.replace(/\r?\n$/, '');
  };
}

function runPath(storage: string, runId: string) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run ID for Git worktree');
  return join(storage, runId);
}

export async function gitRunWorktrees(workspace: string, stateDirectory: string, includePatch = false) {
  const git = gitAt(workspace);
  const repository = await realpath(await git('rev-parse', '--show-toplevel'));
  if (repository !== workspace) throw new Error('Git worktree execution requires the repository root as the workspace');
  const directory = join(stateDirectory, 'run-worktrees');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storage = await realpath(directory);
  const fromRepository = relative(repository, storage);
  if (!isAbsolute(fromRepository) && fromRepository !== '..' && !fromRepository.startsWith('..' + sep)) {
    throw new Error('Git worktree storage must be outside the workspace');
  }
  const prepare = async (runId: string) => {
    const root = runPath(storage, runId);
    // Reserve the path before Git setup. A repeated run must never reuse an earlier checkout.
    try {
      await mkdir(root, { mode: 0o700 });
      const commit = await git('rev-parse', '--verify', 'HEAD^{commit}');
      await writeFile(root + '.base', commit + '\n', { flag: 'wx', mode: 0o600 });
      await git('worktree', 'add', '--detach', '--', root, commit);
    } catch (cause) {
      throw new Error('Unable to prepare the run Git worktree. Inspect the run checkout before retrying.', { cause });
    }
    return root;
  };
  const artifact = async (runId: string, signal: AbortSignal) => {
    const checkout = await inspectRunWorktree(workspace, storage, runId, signal);
    if (checkout.state !== 'ready' || !checkout.baseCommit) throw new Error('Run checkout evidence is unavailable');
    const { baseCommit, head, changes, commits } = checkout;
    const command = gitAt(checkout.root, signal);
    const trackedFiles = await command('diff', '--no-ext-diff', '--no-textconv', '--name-status', baseCommit, '--');
    signal.throwIfAborted();
    const evidence = { version: 1, baseCommit, head, commits, trackedFiles: trackedFiles ? trackedFiles.split('\n') : [], changes };
    let text = JSON.stringify(evidence, null, 2);
    if (includePatch) {
      let patch: string | undefined;
      try {
        patch = await command('diff', '--no-ext-diff', '--no-textconv', '--no-color',
          '--src-prefix=a/', '--dst-prefix=b/', '--patch', baseCommit, '--');
      } catch (error) {
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      }
      const withPatch = patch === undefined ? undefined :
        JSON.stringify({ ...evidence, patch: patch ? patch + '\n' : '' }, null, 2);
      text = withPatch !== undefined && Buffer.byteLength(withPatch) <= 32_000 ? withPatch :
        JSON.stringify({ ...evidence, patchOmitted: 'size_limit' }, null, 2);
    }
    if (Buffer.byteLength(text) > 32_000) throw new Error('Run checkout evidence exceeds the artifact limit');
    return { name: 'git-changes.json', text };
  };
  return { prepare, artifact, includePatch };
}

export async function inspectRunWorktree(workspace: string, storage: string, runId: string, signal?: AbortSignal) {
  const root = runPath(storage, runId);
  const path = await lstat(root).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!path) return { state: 'missing' as const };
  if (!path.isDirectory()) throw new Error('Run checkout is not a directory');
  const marker = await lstat(join(root, '.git')).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!marker) return { state: 'incomplete' as const, root };
  if (!marker.isFile()) throw new Error('Run checkout is not a linked worktree');
  const git = gitAt(root, signal);
  const commonDir = (command: ReturnType<typeof gitAt>) => command('rev-parse', '--path-format=absolute', '--git-common-dir').then(realpath);
  if (await commonDir(git) !== await commonDir(gitAt(workspace, signal))) {
    throw new Error('Run checkout belongs to another repository');
  }
  const baseCommit = await readFile(root + '.base', 'utf8').then(value => value.trim(), error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (baseCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) {
    throw new Error('Invalid run checkout base commit');
  }
  const [head, changes, commits] = await Promise.all([
    git('rev-parse', '--verify', 'HEAD^{commit}'),
    git('--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'),
    baseCommit ? git('log', '--format=%H', '--max-count=100', baseCommit + '..HEAD') : undefined,
  ]);
  return { state: 'ready' as const, root, head, baseCommit: baseCommit ?? null,
    changes: changes ? changes.split('\n') : [], commits: commits === undefined ? null : commits ? commits.split('\n') : [] };
}
