import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export type ClaudeWorker = WorkerCommand & { protocol: 'claude' };

export async function runClaude(worker: ClaudeWorker, root: string, job: JobContext, signal: AbortSignal) {
  const controller = new AbortController();
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const abort = () => controller.abort(active.reason);
  active.addEventListener('abort', abort, { once: true });
  const processes: ReturnType<typeof spawnWorker>[] = [];
  let session: ReturnType<typeof query> | undefined;
  let answer: string | undefined;
  try {
    session = query({
      prompt: jobPrompt(job),
      options: {
        abortController: controller, cwd: root, persistSession: false, settingSources: [],
        permissionMode: 'default', tools: [], strictMcpConfig: true, mcpServers: {},
        settings: { disableClaudeAiConnectors: true },
        canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for this Worker.' }),
        ...(worker.executable !== 'claude' && { pathToClaudeCodeExecutable: worker.executable }),
        spawnClaudeCodeProcess: ({ command, args }) => {
          const process = spawnWorker({ ...worker, executable: command, args }, root);
          processes.push(process);
          return process.child;
        },
      },
    });
    for await (const event of session) {
      if (event.type !== 'result') continue;
      if (event.subtype !== 'success' || event.is_error || answer !== undefined) {
        throw new Error('Claude Code did not return a completed response');
      }
      answer = event.result.slice(0, 4_000);
    }
  } catch {
    active.throwIfAborted();
    throw new Error('Claude Code did not return a completed response');
  } finally {
    active.removeEventListener('abort', abort);
    try {
      session?.close();
    } finally {
      await Promise.all(processes.map(process => process.stop()));
    }
  }
  active.throwIfAborted();
  if (!answer?.trim()) throw new Error('Claude Code did not return a completed response');
  return answer.toWellFormed();
}
