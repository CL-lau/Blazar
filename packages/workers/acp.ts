import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { jobPrompt, type JobContext } from './prompt.ts';
import { spawnWorker, type WorkerCommand } from './process.ts';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

export type AcpWorker = WorkerCommand & { startupTimeoutSeconds?: number };

export function acpStartupSignal(worker: AcpWorker) {
  return AbortSignal.timeout((worker.startupTimeoutSeconds ?? 5) * 1_000);
}
export const deepSeekWorker: AcpWorker = {
  executable: 'dsh',
  args: ['--profile', 'acp'],
  label: 'DeepSeek Harness',
  env: ['DEEPSEEK_API_KEY', 'DSH_HOME'],
};

export type ApprovalHandler = (summary: string, signal: AbortSignal) => Promise<'approved' | 'denied' | undefined>;
type AcpSession = {
  resumeId?: string;
  onCompleted?: (sessionId: string) => void;
};
export class AcpSessionRestoreError extends Error {}

export async function probeAcp(worker: AcpWorker, root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { child, stop } = spawnWorker(worker, root);
  try {
    return await client({ name: 'Blazar' }).connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
        const ready = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION }, {
          cancellationSignal: signal, stopWaitingOnCancel: true,
        });
        if (ready.protocolVersion !== PROTOCOL_VERSION) throw new Error('ACP version is unsupported');
        return {
          version: ready.protocolVersion,
          loadSession: ready.agentCapabilities?.loadSession === true,
          resumeSession: Boolean(ready.agentCapabilities?.sessionCapabilities?.resume),
          ...(ready.authMethods?.length && { authMethodCount: ready.authMethods.length }),
        };
      });
  } finally {
    await stop();
  }
}

export async function runAcp(worker: AcpWorker, root: string, job: JobContext, signal: AbortSignal,
                             approve?: ApprovalHandler,
                             report?: (message: string, signal: AbortSignal) => Promise<void>,
                             continuity?: AcpSession): Promise<string> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  active.throwIfAborted();
  const { child, closed, stop } = spawnWorker(worker, root);
  let sessionId: string | undefined;
  let text = '';
  let reports = Promise.resolve();
  let remainingReports = 8;
  let previousProgress: string | undefined;
  const requested = new Set<string>();
  let asking = false;
  let missingReadLocation = false;
  const peer = client({ name: 'Blazar' })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const cancelled = { outcome: { outcome: 'cancelled' as const } };
      const { toolCall } = params;
      if (active.aborted || !sessionId || sessionId !== params.sessionId || toolCall.kind !== 'read') return cancelled;
      if (!toolCall.locations?.length) {
        missingReadLocation = true;
        return cancelled;
      }
      if (!approve || toolCall.locations.length > 10 ||
          requested.has(toolCall.toolCallId)) return cancelled;
      requested.add(toolCall.toolCallId);
      const targets: string[] = [];
      for (const location of toolCall.locations) {
        if (!isAbsolute(location.path)) return cancelled;
        const target = await realpath(location.path).catch(() => undefined);
        if (!target) return cancelled;
        const path = relative(root, target);
        if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) return cancelled;
        targets.push(JSON.stringify(path));
      }
      const once = params.options.find(option => option.kind === 'allow_once');
      if (!once || active.aborted || asking) return cancelled;
      const heading = worker.label + ' requests one-time read access to workspace files:';
      asking = true;
      let decision: Awaited<ReturnType<ApprovalHandler>>;
      try {
        decision = await approve([heading, ...targets].join('\n').slice(0, 4_000), active);
      } catch {
        return cancelled;
      } finally {
        asking = false;
      }
      if (active.aborted) return cancelled;
      const selected = decision === 'approved' ? once :
        decision === 'denied' ? params.options.find(option => option.kind === 'reject_once') : undefined;
      return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : cancelled;
    })
    .onNotification(methods.client.session.update, ({ params: { sessionId: id, update } }) => {
      if (!sessionId || id !== sessionId) return;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        text += update.content.text.slice(0, Math.max(0, 4_000 - text.length));
      }
      if (!report || active.aborted || !remainingReports ||
          (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return;
      const message = update.status === 'in_progress' ? 'Worker is using a tool' :
        update.status === 'completed' ? 'Worker completed a tool call' :
        update.status === 'failed' ? 'Worker tool call failed' : undefined;
      if (!message || message === previousProgress) return;
      previousProgress = message;
      remainingReports--;
      reports = reports.then(async () => {
        if (!active.aborted) await report(message, active);
      });
      void reports.catch(() => {});
    });
  try {
    return await peer.connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
      const options = { cancellationSignal: active, stopWaitingOnCancel: true };
      let cancelling: Promise<void> | undefined;
      const cancel = () => {
        if (sessionId) {
          cancelling = ctx.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
        }
      };
      active.addEventListener('abort', cancel, { once: true });
      try {
        active.throwIfAborted();
        const ready = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION }, options);
        if (ready.protocolVersion !== PROTOCOL_VERSION) throw new Error('ACP version is unsupported');
        const scope = { cwd: root, mcpServers: [] };
        if (continuity?.resumeId) {
          const parameters = { ...scope, sessionId: continuity.resumeId };
          try {
            if (ready.agentCapabilities?.sessionCapabilities?.resume) {
              await ctx.request(methods.agent.session.resume, parameters, options);
            } else if (ready.agentCapabilities?.loadSession) {
              await ctx.request(methods.agent.session.load, parameters, options);
            } else {
              throw new Error('ACP Worker does not support session restoration');
            }
          } catch (error) {
            active.throwIfAborted();
            throw new AcpSessionRestoreError('ACP Worker could not restore the session', { cause: error });
          }
          sessionId = continuity.resumeId;
        } else {
          const session = await ctx.request(methods.agent.session.new, { cwd: root, mcpServers: [] }, options);
          sessionId = session.sessionId;
        }
        if (!sessionId) throw new Error('ACP Worker returned no session ID');
        active.throwIfAborted();
        const outcome = await ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: jobPrompt(job) }],
        }, options);
        await reports.catch(() => {});
        active.throwIfAborted();
        if (outcome.stopReason !== 'end_turn' || !text.trim()) {
          throw new Error(missingReadLocation ? 'The ACP Worker requested file access without identifying the file.'
            : 'ACP worker did not return a completed response');
        }
        if (ready.agentCapabilities?.loadSession || ready.agentCapabilities?.sessionCapabilities?.resume) {
          continuity?.onCompleted?.(sessionId);
        }
        return text.toWellFormed();
      } finally {
        active.removeEventListener('abort', cancel);
        if (cancelling) {
          await Promise.race([cancelling.then(() => closed), delay(150, undefined, { ref: false })]);
        }
      }
    });
  } catch (error) {
    active.throwIfAborted();
    throw error;
  } finally {
    await stop();
  }
}
