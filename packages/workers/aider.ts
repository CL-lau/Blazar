import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

function lastAssistantReply(history: string): string {
  const lines = history.split(/\r?\n/);
  const start = lines.findLastIndex(line => /^LLM RESPONSE \d{4}-\d{2}-\d{2}T/.test(line));
  if (start < 0) return '';
  const reply: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('ASSISTANT ')) break;
    reply.push(line.slice('ASSISTANT '.length));
  }
  return reply.join('\n').trim().slice(0, 4_000).toWellFormed();
}

export async function runAider(worker: WorkerCommand, root: string, job: JobContext, signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'blazar-aider-'));
  try {
    const message = join(directory, 'message.txt');
    const config = join(directory, 'empty.yml');
    const envFile = join(directory, 'empty.env');
    const history = join(directory, 'llm.log');
    await Promise.all([
      writeFile(message, jobPrompt(job), { mode: 0o600 }),
      writeFile(config, '{}\n', { mode: 0o600 }),
      writeFile(envFile, '', { mode: 0o600 }),
    ]);
    active.throwIfAborted();
    const command = { ...worker, args: [...worker.args,
      '--message-file', message, '--config', config, '--env-file', envFile,
      '--llm-history-file', history, '--chat-history-file', join(directory, 'chat.log'),
      '--input-history-file', join(directory, 'input.log'),
    ] };
    const { child, closed, stop } = spawnWorker(command, root);
    const abort = Promise.withResolvers<void>();
    const onAbort = () => abort.resolve();
    active.addEventListener('abort', onAbort, { once: true });
    try {
      child.stdout.resume();
      child.stdin.on('error', () => {});
      child.stdin.end();
      active.throwIfAborted();
      await Promise.race([closed, abort.promise]);
      active.throwIfAborted();
      if (child.exitCode !== 0) throw new Error('Aider did not finish successfully');
      const metadata = await stat(history).catch(() => undefined);
      if (!metadata?.isFile() || metadata.size > 2 * 1024 * 1024) throw new Error('Aider returned no usable reply');
      const text = lastAssistantReply(await readFile(history, 'utf8'));
      if (!text) throw new Error('Aider returned no usable reply');
      return text;
    } finally {
      active.removeEventListener('abort', onAbort);
      await stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
