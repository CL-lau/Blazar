import { createInterface } from 'node:readline';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export type JsonWorker = WorkerCommand & { protocol: 'claude' };

export async function runJsonWorker(worker: JsonWorker, root: string, job: JobContext, signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  const input = createInterface({ input: child.stdout });
  const abort = Promise.withResolvers<void>();
  const onAbort = () => abort.resolve();
  active.addEventListener('abort', onAbort, { once: true });
  let answer: string | undefined;
  let settled = false;
  let invalid = false;
  input.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { invalid = true; return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'result') {
      settled = event.subtype === 'success' && !event.is_error;
      answer = typeof event.result === 'string' ? event.result.slice(0, 4_000) : undefined;
    }
  });

  try {
    child.stdin.on('error', () => {});
    child.stdin.end(jobPrompt(job));
    await Promise.race([closed, abort.promise]);
    active.throwIfAborted();
    if (invalid || child.exitCode !== 0 || !settled || !answer?.trim()) {
      throw new Error(worker.label + ' did not return a completed response');
    }
    return answer.toWellFormed();
  } finally {
    active.removeEventListener('abort', onAbort);
    input.close();
    await stop();
  }
}
