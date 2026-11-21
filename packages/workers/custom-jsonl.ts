import { createInterface } from 'node:readline';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { textArtifact, type TextArtifact } from '../protocol/artifact.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export type CustomJsonlWorker = WorkerCommand & { protocol: 'jsonl'; includeFullInputArtifacts?: boolean };
export class WorkerQuestion extends Error {}

type Progress = (message: string, signal: AbortSignal) => Promise<void>;

export async function runCustomJsonl(
  worker: CustomJsonlWorker, root: string, job: JobContext, signal: AbortSignal, progress: Progress,
) {
  const drain = new AbortController();
  const active = AbortSignal.any([signal, drain.signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(active.reason);
  active.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_000_000) drain.abort(new Error('JSONL worker output exceeded the limit'));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ version: 1, type: 'run', input: JSON.parse(jobPrompt(job)) }) + '\n');

  async function readResult() {
    let result: string | undefined;
    let artifact: TextArtifact | undefined;
    let failure: string | undefined;
    let question: string | undefined;
    for await (const line of lines) {
      active.throwIfAborted();
      if (Buffer.byteLength(line) > 224_000) throw new Error('JSONL worker event exceeded the limit');
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error('Invalid JSONL worker event'); }
      if (result !== undefined || failure !== undefined || question !== undefined || event?.version !== 1) {
        throw new Error('Invalid JSONL worker event sequence');
      }
      if (event.type === 'progress' && typeof event.message === 'string' &&
          event.message.trim() && event.message.length <= 1_024) {
        await progress(event.message, active);
      } else if (event.type === 'completed' && typeof event.result === 'string' &&
          event.result.trim() && event.result.length <= 4_000) {
        result = event.result.toWellFormed();
        if (event.artifact !== undefined) {
          artifact = textArtifact(event.artifact);
          if (!artifact || artifact.name === 'git-changes.json') throw new Error('Invalid JSONL Worker artifact');
        }
      } else if (event.type === 'question' && typeof event.message === 'string' &&
          event.message.trim() && event.message.length <= 1_000) {
        question = event.message.trim().toWellFormed();
      } else if (event.type === 'failed' && typeof event.message === 'string' &&
          event.message.trim() && event.message.length <= 4_000) {
        failure = event.message.toWellFormed();
      } else {
        throw new Error('Invalid JSONL worker event');
      }
    }
    await closed;
    if (failure) throw new Error(failure);
    if (question && child.exitCode === 0) throw new WorkerQuestion(question);
    if (child.exitCode !== 0 || !result) throw new Error('JSONL worker exited without a successful result');
    return { result, artifact };
  }

  try {
    active.throwIfAborted();
    return await Promise.race([readResult(), interrupted.promise]);
  } finally {
    active.removeEventListener('abort', abort);
    drain.abort();
    lines.close();
    await stop();
  }
}
