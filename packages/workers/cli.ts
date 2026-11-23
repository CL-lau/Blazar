import { createInterface } from 'node:readline';
import { spawnWorker, type WorkerCommand } from './process.ts';

export async function readCliEvents(
  worker: WorkerCommand, root: string, input: string, signal: AbortSignal,
  handleEvent: (event: Record<string, unknown>, signal: AbortSignal) => Promise<void>,
) {
  const drain = new AbortController();
  const active = AbortSignal.any([signal, drain.signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(active.reason);
  active.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 8_000_000) drain.abort(new Error('Agent CLI output exceeded the limit'));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);

  async function read() {
    for await (const line of lines) {
      active.throwIfAborted();
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('Invalid Agent CLI event'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('Invalid Agent CLI event');
      }
      await handleEvent(event, active);
    }
    await closed;
    active.throwIfAborted();
    if (child.exitCode !== 0) throw new Error('Agent CLI exited unsuccessfully');
  }

  try {
    await Promise.race([interrupted.promise, read()]);
  } finally {
    active.removeEventListener('abort', abort);
    drain.abort();
    lines.close();
    await stop();
  }
}
