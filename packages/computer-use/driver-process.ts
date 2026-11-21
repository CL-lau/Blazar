import { spawnWorker } from '../workers/process.ts';

export async function runDriverCommand(executable: string, root: string, argv: string[], signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker({
    executable, args: argv, label: 'Computer observation',
  }, root);
  const interrupted = Promise.withResolvers<void>();
  const abort = () => interrupted.resolve();
  active.addEventListener('abort', abort, { once: true });
  const buffers: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (buffer: Buffer) => {
    size += buffer.length;
    if (size > 512_000) interrupted.resolve();
    else buffers.push(buffer);
  });
  child.stdin.on('error', () => {});
  child.stdin.end();
  try {
    active.throwIfAborted();
    await Promise.race([closed, interrupted.promise]);
    active.throwIfAborted();
    if (size > 512_000) throw new Error('Application snapshot is too large.');
    if (child.exitCode !== 0) throw new Error('Application snapshot failed. Check the app and device permissions.');
    return Buffer.concat(buffers).toString('utf8');
  } finally {
    active.removeEventListener('abort', abort);
    await stop();
  }
}
