import { createInterface } from 'node:readline';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export async function runCodex(worker: WorkerCommand, root: string, job: JobContext, signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  const lines = createInterface({ input: child.stdout });
  child.stdin.on('error', () => {});
  let nextId = 0;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let text = '';
  let ended: { id: string; status: string } | undefined;
  const pending = new Map<number, (value: any) => void>();
  const turnDone = Promise.withResolvers<void>();
  function send(packet: object) {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(packet) + '\n');
  }
  const cancelled = Promise.withResolvers<void>();
  const interrupt = () => {
    if (threadId && turnId) send({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
    cancelled.resolve();
  };
  active.addEventListener('abort', interrupt, { once: true });
  const interrupted = Promise.race([closed, cancelled.promise]).then(() => {
    active.throwIfAborted();
    throw new Error('Codex App Server exited');
  });

  async function request(method: string, params: object) {
    const id = ++nextId;
    const response = new Promise<any>(resolve => pending.set(id, resolve));
    send({ method, id, params });
    try {
      const packet = await Promise.race([response, interrupted]);
      if (packet.error || !packet.result) throw new Error('Codex rejected ' + method);
      return packet.result;
    } finally {
      pending.delete(id);
    }
  }

  lines.on('line', line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    if (!packet || typeof packet !== 'object') return;
    if ('id' in packet && packet.method) {
      send({ id: packet.id, error: { code: -32601, message: 'Blazar does not grant server requests in read-only mode' } });
      return;
    }
    if ('id' in packet) {
      pending.get(packet.id)?.(packet);
      return;
    }
    const params = packet.params;
    if (!threadId || params?.threadId !== threadId) return;
    if (packet.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      text += params.delta.slice(0, Math.max(0, 4_000 - text.length));
    } else if (packet.method === 'turn/completed' && typeof params.turn?.id === 'string') {
      ended = params.turn;
      turnDone.resolve();
    }
  });

  try {
    await request('initialize', { clientInfo: { name: 'blazar', title: 'Blazar', version: '0.1.0' } });
    send({ method: 'initialized' });
    const started = await request('thread/start', {
      cwd: root, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
    });
    if (typeof started.thread?.id !== 'string') throw new Error('Codex returned no thread ID');
    threadId = started.thread.id;
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: jobPrompt(job), text_elements: [] }],
    });
    turnId = turn.turn?.id;
    await Promise.race([turnDone.promise, interrupted]);
    active.throwIfAborted();
    if (!turnId || ended?.id !== turnId || ended.status !== 'completed' || !text.trim()) {
      throw new Error('Codex did not return a completed response');
    }
    return text.toWellFormed();
  } finally {
    active.removeEventListener('abort', interrupt);
    lines.close();
    await stop();
  }
}
