import { readCliEvents } from './cli.ts';
import type { WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export type ClaudeCliWorker = WorkerCommand & { protocol: 'claude-cli' };

export async function runClaudeCli(
  worker: ClaudeCliWorker, root: string, job: JobContext, signal: AbortSignal,
  progress: (message: string, signal: AbortSignal) => Promise<void>, resumeId?: string,
) {
  const args = [
    ...worker.args, '--print', '--verbose', '--output-format', 'stream-json',
    '--setting-sources', '', '--strict-mcp-config', '--tools', '',
    ...(resumeId ? ['--resume', resumeId] : []),
  ];
  let sessionId: string | undefined;
  let result: string | undefined;
  await readCliEvents({ ...worker, args }, root, jobPrompt(job), signal, async (event, active) => {
    if (event.type === 'system' && event.subtype === 'init') {
      if (sessionId || typeof event.session_id !== 'string' || (resumeId && event.session_id !== resumeId)) {
        throw new Error('Claude Code did not confirm the requested session');
      }
      sessionId = event.session_id;
      await progress('Claude Code session started', active);
    }
    if (event.type === 'assistant' && event.session_id === sessionId) {
      const message = event.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        const content = message.content.find(block => block?.type === 'text' && typeof block.text === 'string');
        if (content?.text.trim()) await progress(content.text.slice(0, 1_024).toWellFormed(), active);
      }
    }
    if (event.type === 'result') {
      if (!sessionId || event.session_id !== sessionId || event.subtype !== 'success' ||
          event.is_error !== false || typeof event.result !== 'string' || result !== undefined) {
        throw new Error('Claude Code did not return a completed response');
      }
      result = event.result.slice(0, 4_000).toWellFormed();
    }
  });
  if (!result?.trim() || !sessionId) throw new Error('Claude Code did not return a completed response');
  return { result, sessionId };
}
