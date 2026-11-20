import { setTimeout as delay } from 'node:timers/promises';
import { spawnWorker, type WorkerCommand } from './process.ts';

export async function probePi(worker: WorkerCommand, root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const args = worker.args.map((arg, index) => worker.args[index - 1] === '--mode' ? 'rpc' : arg);
  const { child, closed, stop } = spawnWorker({ ...worker, args }, root);
  const done = new AbortController();
  const response = Promise.withResolvers<{ mode: 'rpc'; modelConfigured: boolean }>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 512_000) {
      response.reject(new Error('Pi RPC handshake exceeded the output limit'));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line);
        if (record?.type !== 'response' || record.id !== 'blazar-probe') continue;
        if (record.command !== 'get_state' || record.success !== true || typeof record.data?.isStreaming !== 'boolean') {
          throw new Error('Invalid Pi state response');
        }
        response.resolve({ mode: 'rpc', modelConfigured: Boolean(record.data.model) });
      } catch {
        response.reject(new Error('Pi returned an invalid RPC handshake'));
      }
    }
  });
  child.stdin.on('error', () => response.reject(new Error('Pi RPC stdin closed')));
  try {
    child.stdin.write(JSON.stringify({ id: 'blazar-probe', type: 'get_state' }) + '\n');
    return await Promise.race([
      response.promise,
      closed.then(() => { throw new Error('Pi exited before the RPC handshake completed'); }),
      delay(5_000, undefined, { signal: AbortSignal.any([signal, done.signal]), ref: false })
        .then(() => { throw new Error('Pi RPC handshake timed out'); }),
    ]);
  } finally {
    done.abort();
    await stop();
  }
}
