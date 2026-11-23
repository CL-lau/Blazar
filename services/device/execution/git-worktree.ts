import { parseTurnDiffFilesFromNumstat } from './git-numstat.ts';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { maxTextArtifactBytes } from '../../../packages/protocol/artifact.ts';
import type { PredecessorInput } from '../../../packages/protocol/task.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { lockDatabaseFile } from '../../../packages/storage/exclusive.ts';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function gitAt(workspace: string, signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return async (...args: string[]) => {
    try {
      const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        { cwd: workspace, env, timeout: 15_000, maxBuffer: 64_000, windowsHide: true, signal });
      return stdout.replace(/\r?\n$/, '');
    } catch (error) {
      const result = error as { code?: number; stdout?: string };
      if (args.includes('--no-index') && result.code === 1 && typeof result.stdout === 'string') {
        return result.stdout.replace(/\r?\n$/, '');
      }
      throw error;
    }
  };
}

function runPath(storage: string, runId: string) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run ID for Git worktree');
  return join(storage, runId);
}

export async function gitRunWorktrees(workspace: string, stateDirectory: string,
  { includePatch = false, applyInputs = false, allowCodexWrite = false } = {}) {
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
  const common = await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  const commonHash = createHash('sha256').update(common).digest('hex');
  const checkoutLock = join(stateDirectory, 'git-worktree-' + commonHash + '.sqlite');
  const prepare = async (runId: string, signal?: AbortSignal) => {
    const root = runPath(storage, runId);
    const deadline = AbortSignal.timeout(15_000);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let release: (() => void) | undefined;
    try {
      while (!release) {
        active.throwIfAborted();
        try {
          release = lockDatabaseFile(checkoutLock, 'Another device is preparing a Git worktree');
        } catch (error) {
          const cause = (error as Error).cause as { errcode?: number } | undefined;
          if (cause?.errcode !== 5) throw error;
          await delay(50, undefined, { signal: active });
        }
      }
      // Allocate a run path only once. A continuation has its own reservation.
      await mkdir(root, { mode: 0o700 });
      const commit = await git('rev-parse', '--verify', 'HEAD^{commit}');
      await writeFile(root + '.base', commit + '\n', { flag: 'wx', mode: 0o600 });
      active.throwIfAborted();
      await git('worktree', 'add', '--detach', '--', root, commit);
      active.throwIfAborted();
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error('Unable to prepare the run Git worktree. Inspect the run checkout before retrying.', { cause });
    } finally {
      release?.();
    }
    return root;
  };
  const continueCheckout = async (runId: string, previousRunId: string, signal: AbortSignal) => {
    const previous = await inspectRunWorktree(workspace, storage, previousRunId, signal);
    if (previous.state !== 'ready' || !previous.baseCommit) return undefined;
    const original = previous.root.slice(storage.length + 1);
    const destination = runPath(storage, runId);
    signal.throwIfAborted();
    await mkdir(destination, { mode: 0o700 });
    await writeFile(destination + '.continuation', original + '\n', { flag: 'wx', mode: 0o600 });
    return previous.root;
  };
  const artifact = async (runId: string, signal: AbortSignal) => {
    const checkout = await inspectRunWorktree(workspace, storage, runId, signal);
    if (checkout.state !== 'ready' || !checkout.baseCommit) throw new Error('Run checkout evidence is unavailable');
    const { baseCommit, head, changes, commits } = checkout;
    const command = gitAt(checkout.root, signal);
    const trackedFiles = await command('diff', '--no-ext-diff', '--no-textconv', '--name-status', baseCommit, '--');
    signal.throwIfAborted();
    const evidence = { version: 1, baseCommit, head, commits, trackedFiles: trackedFiles ? trackedFiles.split('\n') : [], changes };
    let fileStats: ReturnType<typeof parseTurnDiffFilesFromNumstat> | undefined;
    try {
      fileStats = parseTurnDiffFilesFromNumstat(await command(
        'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', baseCommit, '--'));
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    }
    const serialize = (report: object) => {
      const detailed = JSON.stringify({ ...report, fileStats }, null, 2);
      return Buffer.byteLength(detailed) <= maxTextArtifactBytes ? detailed : JSON.stringify(report, null, 2);
    };
    let text = serialize(evidence);
    if (includePatch) {
      let patch: string | undefined;
      try {
        patch = await command('diff', '--no-ext-diff', '--no-textconv', '--no-color',
          '--src-prefix=a/', '--dst-prefix=b/', '--patch', '--binary', baseCommit, '--');
        const untracked = (await command('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
        for (const file of untracked) {
          signal.throwIfAborted();
          const path = join(checkout.root, file);
          const metadata = await lstat(path);
          if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
          const addition = await command('diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
            '--src-prefix=a/', '--dst-prefix=b/', '--patch', '--binary', '--', '/dev/null', file);
          patch = [patch, addition].filter(Boolean).join('\n');
          if (Buffer.byteLength(patch) > maxTextArtifactBytes) {
            patch = undefined;
            break;
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      }
      const withPatch = patch === undefined ? undefined :
        serialize({ ...evidence, patch: patch ? patch + '\n' : '' });
      text = withPatch !== undefined && Buffer.byteLength(withPatch) <= maxTextArtifactBytes ? withPatch :
        serialize({ ...evidence, patchOmitted: 'size_limit' });
    }
    if (Buffer.byteLength(text) > maxTextArtifactBytes) throw new Error('Run checkout evidence exceeds the artifact limit');
    return { name: 'git-changes.json', text };
  };
  return { prepare, continueCheckout, artifact, includePatch, applyInputs, allowCodexWrite };
}

export class GitPatchInputError extends Error {}

export async function applyGitPatchInputs(root: string, inputs: PredecessorInput[], signal: AbortSignal) {
  if (!inputs.length) throw new GitPatchInputError('No Git patch inputs were assigned');
  const git = gitAt(root, signal);
  const base = await git('rev-parse', '--verify', 'HEAD^{commit}');
  const patches = inputs.map(input => {
    if (input.artifact?.name !== 'git-changes.json' || !input.artifact.text) {
      throw new GitPatchInputError('A required Git patch artifact is unavailable');
    }
    let report: { version?: number; baseCommit?: string; patch?: unknown; changes?: unknown } | null;
    try {
      report = JSON.parse(input.artifact.text);
    } catch {
      throw new GitPatchInputError('A required Git patch artifact is malformed');
    }
    if (report?.version !== 1 || report.baseCommit !== base) {
      throw new GitPatchInputError('Git patch inputs do not match the checkout base commit');
    }
    if (typeof report.patch !== 'string' || (report.patch && !report.patch.startsWith('diff --git ')) ||
        /^(?:Binary files |GIT binary patch$)/m.test(report.patch) ||
        !Array.isArray(report.changes) || report.changes.some(change => typeof change !== 'string' || change.startsWith('?? '))) {
      throw new GitPatchInputError('A required Git patch is incomplete or contains unsupported file changes');
    }
    return report.patch;
  }).filter(Boolean);
  if (!patches.length) return;
  const scratch = await mkdtemp(join(tmpdir(), 'blazar-git-patch-'));
  try {
    const patch = join(scratch, 'inputs.patch');
    await writeFile(patch, patches.join('\n'), { flag: 'wx', mode: 0o600 });
    await git('apply', '--check', '--index', '--whitespace=nowarn', '--', patch);
    await git('apply', '--index', '--whitespace=nowarn', '--', patch);
  } catch (cause) {
    signal.throwIfAborted();
    throw new GitPatchInputError('Git patch inputs conflict with each other or the checkout. Inspect the retained worktree.', { cause });
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

export async function inspectRunWorktree(workspace: string, storage: string, runId: string, signal?: AbortSignal) {
  const entry = runPath(storage, runId);
  const continuation = await readFile(entry + '.continuation', 'utf8').then(value => value.trim(), error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const root = continuation ? runPath(storage, continuation) : entry;
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
