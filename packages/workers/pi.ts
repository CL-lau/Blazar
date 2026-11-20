import { setTimeout as delay } from 'node:timers/promises';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext, type OnSteerReady } from './prompt.ts';

export type PiWorker = WorkerCommand & { protocol: 'pi' };

async function piRequest<T>(worker: WorkerCommand, root: string, signal: AbortSignal,
                            command: object, read: (record: any, send: (value: object) => void) => T | undefined): Promise<T> {
  signal.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  const response = Promise.withResolvers<T>();
  const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
  const abort = () => {
    if (!child.stdin.destroyed) send({ id: 'blazar-abort', type: 'abort' });
    response.reject(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 512_000) {
      response.reject(new Error('Pi RPC record exceeded the output limit'));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const record = JSON.parse(line);
        const result = read(record, send);
        if (result !== undefined) response.resolve(result);
      } catch (error) {
        response.reject(error instanceof SyntaxError ? new Error('Pi returned an invalid RPC record') : error);
      }
    }
  });
  child.stdin.on('error', () => response.reject(new Error('Pi RPC stdin closed')));
  try {
    send(command);
    return await Promise.race([
      response.promise,
      closed.then(() => { throw new Error('Pi exited before the RPC command completed'); }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
    child.stdin.end();
    if (signal.aborted) await Promise.race([closed, delay(150, undefined, { ref: false })]);
    await stop();
  }
}

export function probePi(worker: WorkerCommand, root: string, signal: AbortSignal) {
  return piRequest(worker, root, signal, { id: 'blazar-probe', type: 'get_state' }, record => {
    if (record?.type !== 'response' || record.id !== 'blazar-probe') return;
    if (record.command !== 'get_state' || record.success !== true || typeof record.data?.isStreaming !== 'boolean') {
      throw new Error('Invalid Pi state response');
    }
    return { mode: 'rpc' as const, modelConfigured: Boolean(record.data.model) };
  });
}

export async function runPi(worker: WorkerCommand, root: string, job: JobContext, signal: AbortSignal,
                            onSteerReady?: OnSteerReady) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  let answer: string | undefined;
  let accepted = false;
  let settled = false;
  let clearSteer: (() => void) | undefined;
  let pending: { id: string; text: string; queued: boolean; delivered: boolean; resolve: (accepted: boolean) => void } | undefined;
  try {
    return await piRequest(worker, root, active, { id: 'blazar-prompt', type: 'prompt', message: jobPrompt(job) }, (record, send) => {
      if (record?.type === 'response' && record.id === 'blazar-prompt') {
        if (record.command !== 'prompt' || record.success !== true || record.data?.disposition !== 'started') {
          throw new Error('Pi did not start the requested run');
        }
        accepted = true;
        if (!settled && !clearSteer) {
          clearSteer = onSteerReady?.((text, id) => {
            if (active.aborted || settled || pending || !text.trim()) return Promise.resolve(false);
            const acknowledgment = Promise.withResolvers<boolean>();
            pending = { id, text, queued: false, delivered: false, resolve: acknowledgment.resolve };
            send({ type: 'steer', id, message: text });
            return acknowledgment.promise;
          });
        }
      } else if (pending && record?.type === 'response' && record.id === pending.id) {
        if (record.command !== 'steer' || record.success !== true || record.data?.disposition !== 'queued') {
          pending.resolve(false);
          pending = undefined;
        } else {
          pending.queued = true;
        }
      } else if (pending && record?.type === 'message_end' && record.message?.role === 'user') {
        const content = record.message.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(part => part?.type === 'text').map(part => part.text).join('') : undefined;
        if (text === pending.text) {
          pending.delivered = true;
          answer = undefined;
        }
      } else if (record?.type === 'message_end' && record.message?.role === 'assistant') {
        const message = record.message;
        answer = message.stopReason === 'stop' && Array.isArray(message.content)
          ? message.content.reduce((text: string, part: { type?: string; text?: unknown } | null) =>
            part?.type === 'text' && typeof part.text === 'string'
              ? text + part.text.slice(0, Math.max(0, 4_000 - text.length)) : text, '')
          : undefined;
      } else if (record?.type === 'agent_settled') {
        if (record.aborted !== false) throw new Error('Pi did not return a completed response');
        settled = true;
      }
      if (pending?.queued && pending.delivered) {
        pending.resolve(true);
        pending = undefined;
      }
      if (!accepted || !settled) return;
      if (!answer?.trim()) throw new Error('Pi did not return a completed response');
      return answer.toWellFormed();
    });
  } finally {
    clearSteer?.();
    pending?.resolve(false);
  }
}
