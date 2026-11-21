import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class WorkerCleanupError extends Error {
  constructor(cause: unknown) { super('Worker process cleanup could not be verified', { cause }); }
}

export type WorkerCommand = { executable: string; args: string[]; label: string; env?: string[] };

export function spawnWorker(worker: WorkerCommand, root: string) {
  const env: NodeJS.ProcessEnv = {};
  const inherited = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
  for (const name of [...inherited, ...(worker.env ?? [])]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const processGroup = process.platform !== 'win32';
  const child = spawn(worker.executable, worker.args, {
    cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'], detached: processGroup, shell: false,
  });
  const closed = new Promise<void>(resolve => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  function terminate(force: boolean) {
    if (!child.pid) return;
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    try {
      if (processGroup) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  function groupExists() {
    if (!processGroup || !child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || (code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null))) return false;
      throw error;
    }
  }
  let stopping: Promise<void> | undefined;
  async function stop(graceful: boolean) {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!groupExists()) return closed;
    }
    if (graceful && child.exitCode === null && child.signalCode === null) {
      // Give a completed stdio session a bounded chance to flush its checkpoint.
      child.stdin.end();
      const exited = await Promise.race([closed.then(() => true), delay(1_000, false, { ref: false })]);
      if (exited && !groupExists()) return;
    }
    const grace = new AbortController();
    const elapsed = delay(500, false, { signal: grace.signal }).catch(() => false);
    try {
      try {
        terminate(false);
      } catch (error) {
        if (!processGroup || (error as NodeJS.ErrnoException).code !== 'EPERM' ||
            !await Promise.race([closed.then(() => true), elapsed])) throw error;
      }
      const exited = await Promise.race([closed.then(() => true), elapsed]);
      if (exited && !groupExists()) return;
      if (exited) await elapsed;
      if (!exited || groupExists()) terminate(true);
      await closed;
    } finally {
      grace.abort();
    }
  }

  return {
    child, closed,
    stop: (graceful = false) => stopping ??= stop(graceful).catch(error => { throw new WorkerCleanupError(error); }),
  };
}
