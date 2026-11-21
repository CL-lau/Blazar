import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpSessionRestoreError, runAcp } from '../../../packages/workers/acp.ts';
import { runAider } from '../../../packages/workers/aider.ts';
import { runClaude } from '../../../packages/workers/claude.ts';
import { runCodex } from '../../../packages/workers/codex.ts';
import { runCustomJsonl } from '../../../packages/workers/custom-jsonl.ts';
import { runPi } from '../../../packages/workers/pi.ts';
import type { JobContext, WorkerSteer } from '../../../packages/workers/prompt.ts';
import type { Worker } from '../../../packages/workers/registry.ts';
import type { PredecessorInput } from '../../../packages/protocol/task.ts';
import type { DeviceLedger, SessionCheckpoint } from '../ledger.ts';

interface WorkerExecution {
  root: string;
  scope: string;
  workspaceIdentity: string;
  revision?: string;
  ledger: Pick<DeviceLedger, 'takeSession'>;
  post: (path: string, data: object, signal: AbortSignal) => Promise<Response>;
  approve: (prefix: string, summary: string, signal: AbortSignal) =>
    Promise<{ id: string; decision: 'approved' | 'denied' } | undefined>;
  consumeApproval: (prefix: string, id: string, signal: AbortSignal) => Promise<boolean>;
}

export async function executeWorker(
  context: WorkerExecution, worker: Worker, prefix: string, taskId: string, job: JobContext,
  stop: AbortController, active: AbortSignal,
): Promise<{ result: string; checkpoint?: SessionCheckpoint }> {
  let sequence = 1;
  const report = async (message: string, signal: AbortSignal) => {
    const reply = await context.post(prefix + 'progress', { seq: ++sequence, message }, signal);
    await reply.body?.cancel();
    if (!reply.ok) throw new Error('Router rejected Worker progress');
  };
  switch (worker.protocol) {
    case 'jsonl':
      if (worker.includeFullInputArtifacts) await completeInputArtifacts(context, job.predecessors, prefix, active);
      return { result: await runCustomJsonl(worker, context.root, job, active, report) };
    case 'pi':
    case 'codex':
      return { result: await runSteerableWorker(context, worker, prefix, job, stop, active) };
    case 'claude':
      return { result: await runClaude(worker, context.root, job, active) };
    case 'aider':
      return { result: await runAider(worker, context.root, job, active) };
    default:
      return runAcpWorker(context, worker, prefix, taskId, job, active, report);
  }
}

async function steerWorker(context: WorkerExecution, prefix: string, steer: WorkerSteer, finished: AbortSignal,
                         stop: AbortController, active: AbortSignal) {
  const polling = AbortSignal.any([finished, active]);
  let appliedVersion: number | undefined;
  try {
    while (!polling.aborted || (appliedVersion !== undefined && !active.aborted)) {
      const response = await context.post(prefix + 'steer', { appliedVersion }, appliedVersion === undefined ? polling : active);
      if (!response.ok) {
        await response.body?.cancel();
        if (!finished.aborted) stop.abort();
        return;
      }
      const { instruction } = await response.json() as {
        instruction: { version: number; text: string; messageId: string } | null;
      };
      appliedVersion = undefined;
      if (polling.aborted) return;
      if (instruction) {
        if (!await steer(instruction.text, instruction.messageId)) {
          if (!finished.aborted) stop.abort();
          return;
        }
        appliedVersion = instruction.version;
      } else {
        await delay(250, undefined, { signal: polling });
      }
    }
  } catch {
    if (!polling.aborted) stop.abort();
  }
}

async function runSteerableWorker(context: WorkerExecution, worker: Worker, prefix: string, job: JobContext,
                             stop: AbortController, active: AbortSignal) {
  const finished = new AbortController();
  let steering: Promise<void> | undefined;
  try {
    const run = worker.protocol === 'pi' ? runPi : runCodex;
    return await run(worker, context.root, job, active, steer => {
      steering = steerWorker(context, prefix, steer, finished.signal, stop, active);
      return () => finished.abort();
    });
  } finally {
    finished.abort();
    await steering;
  }
}

async function runAcpWorker(execution: WorkerExecution, worker: Worker, prefix: string, taskId: string, job: JobContext, active: AbortSignal,
                           report: (message: string, signal: AbortSignal) => Promise<void>) {
  const key = createHash('sha256').update(JSON.stringify([
    execution.scope, execution.workspaceIdentity, execution.revision, taskId, job.goal,
    job.acceptanceCriteria, job.memoryInputs?.map(({ id, version }) => [id, version]),
    job.predecessors.map(({ taskId, version }) => [taskId, version]),
    ...(job.attachments?.length ? [job.attachments] : []),
  ])).digest('hex');
  const instructionCount = job.instructions.length;
  const previous = execution.ledger.takeSession(key, instructionCount);
  let checkpoint: SessionCheckpoint | undefined;
  const run = (context: JobContext, resumeId?: string) => runAcp(worker, execution.root, context, active,
    async (summary, signal) => {
      const decision = await execution.approve(prefix, summary, signal);
      if (decision?.decision !== 'approved') return decision?.decision;
      if (await execution.consumeApproval(prefix, decision.id, signal)) return 'approved';
      return undefined;
    }, report, { resumeId, onCompleted: id => { checkpoint = { key, id, instructionCount }; } });
  let result: string;
  try {
    result = previous
      ? await run({ ...job, instructions: job.instructions.slice(previous.instructionCount) }, previous.id)
      : await run(job);
  } catch (error) {
    if (!(error instanceof AcpSessionRestoreError)) throw error;
    result = await run(job);
  }
  return { result, checkpoint };
}

async function completeInputArtifacts(context: WorkerExecution, inputs: PredecessorInput[], prefix: string, signal: AbortSignal) {
  let budget = 64_000;
  for (const input of inputs) {
    const artifact = input.artifact;
    if (!artifact || !artifact.truncated || artifact.size > budget || artifact.size <= 0) continue;
    const response = await context.post(prefix + 'input-artifact', { artifactId: artifact.id }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Unable to read a required workflow input');
    }
    const { text } = await response.json() as { text?: unknown };
    if (typeof text !== 'string' || Buffer.byteLength(text) !== artifact.size ||
        createHash('sha256').update(text).digest('hex') !== artifact.sha256) {
      throw new Error('Workflow input artifact failed integrity verification');
    }
    artifact.text = text;
    budget -= artifact.size;
  }
}
