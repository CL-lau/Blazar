import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function gitRunWorktrees(workspace: string, stateDirectory: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = async (...args: string[]) => {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd: workspace, env, timeout: 15_000, maxBuffer: 64_000, windowsHide: true });
    return stdout.replace(/\r?\n$/, '');
  };
  const repository = await realpath(await git('rev-parse', '--show-toplevel'));
  if (repository !== workspace) throw new Error('Git worktree execution requires the repository root as the workspace');
  const directory = join(stateDirectory, 'run-worktrees');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storage = await realpath(directory);
  const fromRepository = relative(repository, storage);
  if (!isAbsolute(fromRepository) && fromRepository !== '..' && !fromRepository.startsWith('..' + sep)) {
    throw new Error('Git worktree storage must be outside the workspace');
  }
  return async (runId: string) => {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run ID for Git worktree');
    const root = join(storage, runId);
    // Reserve the path before Git setup. A repeated run must never reuse an earlier checkout.
    try {
      await mkdir(root, { mode: 0o700 });
      const commit = await git('rev-parse', '--verify', 'HEAD^{commit}');
      await git('worktree', 'add', '--detach', '--', root, commit);
    } catch (cause) {
      throw new Error('Unable to prepare the run Git worktree. Inspect the run checkout before retrying.', { cause });
    }
    return root;
  };
}
