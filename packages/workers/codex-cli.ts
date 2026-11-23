import { readCliEvents } from './cli.ts';
import type { WorkerCommand } from './process.ts';
import { jobPrompt, type JobContext } from './prompt.ts';

export type CodexCliWorker = WorkerCommand & { protocol: 'codex-cli' };

export async function runCodexCli(
  worker: CodexCliWorker, root: string, job: JobContext, signal: AbortSignal,
  progress: (message: string, signal: AbortSignal) => Promise<void>, resumeId?: string,
) {
  const config = [
    'approval_policy="never"',
    'sandbox_mode="' + (job.writableWorktreeRequired ? 'workspace-write' : 'read-only') + '"',
    'sandbox_workspace_write={writable_roots=[],network_access=false,exclude_tmpdir_env_var=true,exclude_slash_tmp=true}',
    'mcp_servers={}',
  ].flatMap(value => ['-c', value]);
  const args = [
    ...worker.args, 'exec', ...(resumeId ? ['resume'] : []), '--json', '--ignore-user-config', '--ignore-rules',
    ...config, ...(resumeId ? [resumeId] : []), '-',
  ];
  let sessionId: string | undefined;
  let result: string | undefined;
  let completed = false;
  await readCliEvents({ ...worker, args }, root, jobPrompt(job), signal, async (event, active) => {
    if (event.type === 'thread.started') {
      if (sessionId || typeof event.thread_id !== 'string' || (resumeId && event.thread_id !== resumeId)) {
        throw new Error('Codex did not confirm the requested session');
      }
      sessionId = event.thread_id;
      await progress('Codex session started', active);
    }
    if (event.type === 'turn.failed') throw new Error('Codex CLI turn failed');
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string' && event.type === 'item.completed') {
        result = item.text.slice(0, 4_000).toWellFormed();
        if (result.trim()) await progress(result.slice(0, 1_024).toWellFormed(), active);
      } else if (event.type === 'item.started' && item?.type === 'command_execution') {
        await progress('Codex is running a command', active);
      }
    }
  });
  if (!completed || !result?.trim() || !sessionId) throw new Error('Codex CLI did not return a completed response');
  return { result, sessionId };
}
