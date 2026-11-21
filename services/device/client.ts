import { WorkerCleanupError } from '../../packages/workers/process.ts';
import { clickApp, observeApp, type ObservationConfig } from '../../packages/computer-use/observe.ts';
import { DeviceSocket } from './socket.ts';
import { runAider } from '../../packages/workers/aider.ts';
import { runCustomJsonl } from '../../packages/workers/custom-jsonl.ts';
import { runPi } from '../../packages/workers/pi.ts';
import { runClaude } from '../../packages/workers/claude.ts';
import type { JobContext, WorkerSteer } from '../../packages/workers/prompt.ts';
import { runCodex } from '../../packages/workers/codex.ts';
import type { Worker } from '../../packages/workers/registry.ts';
import { AcpSessionRestoreError, runAcp } from '../../packages/workers/acp.ts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DeviceLedger, type SessionCheckpoint } from './ledger.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { PredecessorInput, Run, RunOutcome, Task, WorkerConfiguration } from '../../packages/protocol/task.ts';
import { performance } from 'node:perf_hooks';
import { maintainLease } from './lease.ts';
import { platform } from 'node:os';
import { preview } from './preview.ts';

type Assignment = { run: Run; task: Task; instructions: string[]; predecessors: PredecessorInput[]; acceptanceCriteria?: string[] };

export class DeviceClient {
  private socket: DeviceSocket;
  private root: string;
  private ledger: DeviceLedger;
  private scope: string;
  private worker?: Worker;
  private workerConfiguration?: WorkerConfiguration;
  private observation?: ObservationConfig;
  private workspaceIdentity: string;
  private claimId = randomUUID();

  constructor(base: URL, token: string, root: string, ledger: DeviceLedger, worker?: Worker, observation?: ObservationConfig, workspaceIdentity = root) {
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) {
      throw new Error('Router URL must use HTTPS or local loopback HTTP.');
    }
    this.socket = new DeviceSocket(base, token);
    this.root = root;
    this.workspaceIdentity = workspaceIdentity;
    this.ledger = ledger;
    this.worker = worker;
    if (worker) {
      const protocol = worker.protocol ?? 'acp';
      const adapterVersion = 1;
      // Keep executable paths and arguments local, even if they contain sensitive values.
      const revision = createHmac('sha256', token).update(JSON.stringify([
        adapterVersion, worker.label, protocol, worker.executable, worker.args, worker.env ?? [],
        worker.protocol === 'jsonl' && worker.includeFullInputArtifacts === true,
      ])).digest('hex');
      this.workerConfiguration = { label: worker.label, protocol, adapterVersion, revision };
    }
    this.observation = observation;
    this.scope = createHash('sha256').update(JSON.stringify([base.origin, token])).digest('hex');
  }

  private post(path: string, body: object, signal: AbortSignal) {
    return this.socket.request(path, body, signal);
  }

  close() {
    this.socket.close();
  }

  private async deliver(runId: string, outcome: RunOutcome, signal: AbortSignal) {
    const finished = await this.post(`runs/${runId}/finish`, outcome, signal);
    if (!finished.ok && finished.status !== 409) {
      await finished.body?.cancel();
      throw new Error(`Result submission failed (${finished.status})`);
    }
    await finished.body?.cancel();
    this.ledger.acknowledge(this.scope, runId, finished.ok);
  }

  private async approve(prefix: string, summary: string, signal: AbortSignal) {
    const asked = await this.post(prefix + 'request-approval', { summary }, signal);
    if (!asked.ok) {
      await asked.body?.cancel();
      return undefined;
    }
    const { approval } = await asked.json() as { approval: { id: string; expires: number } };
    while (!signal.aborted && Date.now() < approval.expires) {
      const response = await this.post(prefix + 'approval', { approvalId: approval.id }, signal);
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const { decision } = await response.json() as { decision: 'approved' | 'denied' | null };
      if (decision) return { id: approval.id, decision };
      await delay(1_000, undefined, { signal });
    }
    return undefined;
  }

  private async consumeApproval(prefix: string, approvalId: string, signal: AbortSignal) {
    const response = await this.post(prefix + 'consume-approval', { approvalId }, signal);
    await response.body?.cancel();
    return response.ok;
  }

  private async steerWorker(prefix: string, steer: WorkerSteer, finished: AbortSignal,
                           stop: AbortController, active: AbortSignal) {
    const polling = AbortSignal.any([finished, active]);
    let appliedVersion: number | undefined;
    try {
      while (!polling.aborted || (appliedVersion !== undefined && !active.aborted)) {
        const response = await this.post(prefix + 'steer', { appliedVersion }, appliedVersion === undefined ? polling : active);
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

  private async runSteerableWorker(worker: Worker, prefix: string, job: JobContext,
                               stop: AbortController, active: AbortSignal) {
    const finished = new AbortController();
    let steering: Promise<void> | undefined;
    try {
      const run = worker.protocol === 'pi' ? runPi : runCodex;
      return await run(worker, this.root, job, active, steer => {
        steering = this.steerWorker(prefix, steer, finished.signal, stop, active);
        return () => finished.abort();
      });
    } finally {
      finished.abort();
      await steering;
    }
  }

  private async runAcpWorker(worker: Worker, prefix: string, taskId: string, job: JobContext, active: AbortSignal,
                             report: (message: string, signal: AbortSignal) => Promise<void>) {
    const key = createHash('sha256').update(JSON.stringify([
      this.scope, this.workspaceIdentity, this.workerConfiguration?.revision, taskId, job.goal,
      job.acceptanceCriteria, job.predecessors.map(({ taskId, version }) => [taskId, version]),
    ])).digest('hex');
    const instructionCount = job.instructions.length;
    const previous = this.ledger.takeSession(key, instructionCount);
    let checkpoint: SessionCheckpoint | undefined;
    const run = (context: JobContext, resumeId?: string) => runAcp(worker, this.root, context, active,
      async (summary, signal) => {
        const decision = await this.approve(prefix, summary, signal);
        if (decision?.decision !== 'approved') return decision?.decision;
        if (await this.consumeApproval(prefix, decision.id, signal)) return 'approved';
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

  private async completeInputArtifacts(inputs: PredecessorInput[], prefix: string, signal: AbortSignal) {
    let budget = 64_000;
    for (const input of inputs) {
      const artifact = input.artifact;
      if (!artifact || !artifact.truncated || artifact.size > budget || artifact.size <= 0) continue;
      const response = await this.post(prefix + 'input-artifact', { artifactId: artifact.id }, signal);
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

  async runOnce(signal: AbortSignal): Promise<boolean> {
    const interrupted = this.ledger.interrupted(this.workspaceIdentity);
    if (interrupted) {
      try {
        const response = await this.post('interrupted', { runId: interrupted }, signal);
        await response.body?.cancel();
        if (!response.ok) throw new Error('Router rejected the interruption report');
      } catch (error) {
        throw new Error('Workspace has an interrupted run that requires reconciliation: ' + interrupted, { cause: error });
      }
      return false;
    }
    const pending = this.ledger.next(this.scope);
    if (pending) {
      await this.deliver(pending.runId, pending.outcome, signal);
      return true;
    }
    const claimStarted = performance.now();
    const claim = await this.post('claim', {
      capability: this.observation ? 'computer.observe' : this.worker ? 'agent.acp' : 'document.preview', requestId: this.claimId, platform: platform(),
      worker: this.workerConfiguration,
      desktopApps: this.observation ? [...this.observation.apps.keys()] : undefined,
    }, signal);
    if (!claim.ok) throw new Error(`Task claim failed (${claim.status})`);
    const { assignment, leaseRemainingMs } = await claim.json() as { assignment: Assignment | null; leaseRemainingMs?: number };
    this.claimId = randomUUID();
    if (!assignment) return false;

    const prefix = `runs/${assignment.run.id}/`;
    const stop = new AbortController();
    const active = AbortSignal.any([signal, stop.signal]);
    if (typeof leaseRemainingMs !== 'number' || !Number.isSafeInteger(leaseRemainingMs) ||
        leaseRemainingMs <= 0 || leaseRemainingMs > 45_000) throw new Error('Invalid execution lease');
    const deadline = claimStarted + leaseRemainingMs;
    if (deadline <= performance.now()) throw new Error('Task claim has no usable execution lease');
    const unwatch = this.socket.onStop(assignment.run.id, () => stop.abort());
    const heartbeat = maintainLease(deadline, async attempt => {
      const renewed = await this.post(prefix + 'renew', {}, attempt);
      if (!renewed.ok) {
        await renewed.body?.cancel();
        if (renewed.status >= 500) throw new Error('Router renewal is temporarily unavailable');
        return false;
      }
      const { leaseRemainingMs } = await renewed.json() as { leaseRemainingMs?: number };
      return typeof leaseRemainingMs === 'number' && Number.isSafeInteger(leaseRemainingMs) &&
        leaseRemainingMs > 0 && leaseRemainingMs <= 45_000 ? leaseRemainingMs : false;
    }, stop, active);
    try {
      const progress = await this.post(prefix + 'progress', { seq: 1, message: this.observation ? 'Observing the configured application' : this.worker ? 'Running ' + this.worker.label : 'Reading the workspace document' }, active);
      await progress.body?.cancel();
      if (progress.status === 409) {
        await this.deliver(assignment.run.id, { status: 'failed', result: 'The task changed before preview started.' }, active);
        return true;
      }
      if (!progress.ok) throw new Error(`Progress submission failed (${progress.status})`);
      active.throwIfAborted();
      this.ledger.begin(this.workspaceIdentity, assignment.run.id);
      let outcome: RunOutcome;
      let checkpoint: SessionCheckpoint | undefined;
      try {
        if (this.observation) {
          const click = assignment.task.goal.startsWith('/click ');
          const result = click
            ? await clickApp(this.observation, this.root, assignment.task.goal, active,
              async (summary, signal) => {
                const decision = await this.approve(prefix, summary, signal);
                if (decision?.decision !== 'approved') return undefined;
                return () => this.consumeApproval(prefix, decision.id, signal);
              })
            : await observeApp(this.observation, this.root, assignment.task.goal, active);
          outcome = { status: 'succeeded', result: click ? 'Application action completed.' : 'Application snapshot is ready.',
            artifact: { name: 'application-observation.txt', text: result } };
        } else if (this.worker) {
          if (this.worker.protocol === 'jsonl' && this.worker.includeFullInputArtifacts) {
            await this.completeInputArtifacts(assignment.predecessors, prefix, active);
          }
          const job = { goal: assignment.task.goal, instructions: assignment.instructions,
            predecessors: assignment.predecessors, acceptanceCriteria: assignment.acceptanceCriteria };
          let sequence = 1;
          const report = async (message: string, signal: AbortSignal) => {
            const reply = await this.post(prefix + 'progress', { seq: ++sequence, message }, signal);
            await reply.body?.cancel();
            if (!reply.ok) throw new Error('Router rejected Worker progress');
          };
          const result = this.worker.protocol === 'jsonl'
            ? await runCustomJsonl(this.worker, this.root, job, active, report)
            : this.worker.protocol === 'pi' || this.worker.protocol === 'codex'
            ? await this.runSteerableWorker(this.worker, prefix, job, stop, active)
            : this.worker.protocol === 'claude'
            ? await runClaude(this.worker, this.root, job, active)
              : this.worker.protocol === 'aider'
                ? await runAider(this.worker, this.root, job, active)
                : await this.runAcpWorker(this.worker, prefix, assignment.task.id, job, active, report);
          if (typeof result !== 'string') checkpoint = result.checkpoint;
          const text = typeof result === 'string' ? result : result.result;
          outcome = { status: 'succeeded', result: text, artifact: { name: 'worker-result.txt', text } };
        } else {
          if (assignment.instructions.length) throw new Error('Submit a new preview to change the document path.');
          const document = await preview(this.root, assignment.task.goal, active);
          const result = Array.from(document).slice(0, 4_000).join('');
          outcome = { status: 'succeeded', result, artifact: { name: 'preview.txt', text: result } };
        }
      } catch (error) {
        if (error instanceof WorkerCleanupError) throw error;
        if (active.aborted) {
          this.ledger.clearExecution(this.workspaceIdentity, assignment.run.id);
          active.throwIfAborted();
        }
        outcome = { status: 'failed', result: error instanceof Error ? error.message : 'Preview failed' };
      }
      this.ledger.complete(this.workspaceIdentity, this.scope, assignment.run.id, outcome, checkpoint);
      await this.deliver(assignment.run.id, outcome, active);
      return true;
    } finally {
      unwatch();
      const interrupted = stop.signal.aborted;
      stop.abort();
      await heartbeat;
      if (interrupted && !signal.aborted && !this.ledger.interrupted(this.workspaceIdentity)) {
        try {
          const stopped = await this.post(prefix + 'stopped', {}, signal);
          await stopped.body?.cancel();
        } catch { /* Router will reconcile the run after the lease expires. */ }
      }
    }
  }
}
