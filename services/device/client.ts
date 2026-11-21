import { WorkerCleanupError } from '../../packages/workers/process.ts';
import { DesktopResultUnverified, probeComputer, type ObservationConfig } from '../../packages/computer-use/observe.ts';
import { DeviceSocket } from './socket.ts';
import type { Worker } from '../../packages/workers/registry.ts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DeviceLedger, type SessionCheckpoint } from './ledger.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { PredecessorInput, Run, RunOutcome, Task, TaskAttachment, TaskMemoryInput, WorkerCapability, WorkerConfiguration } from '../../packages/protocol/task.ts';
import { performance } from 'node:perf_hooks';
import { maintainLease } from './lease.ts';
import { platform } from 'node:os';
import { preview } from './preview.ts';
import { executeDesktopAction } from './execution/desktop.ts';
import type { gitRunWorktrees } from './execution/git-worktree.ts';
import { executeWorker } from './execution/worker.ts';

type Assignment = { clickExpectedText?: string; fullInputRequired?: boolean; readOnlyRequired?: boolean; run: Run; task: Task; instructions: string[]; predecessors: PredecessorInput[]; acceptanceCriteria?: string[]; memoryInputs?: TaskMemoryInput[]; attachments?: TaskAttachment[] };

export class DeviceClient {
  private socket: DeviceSocket;
  private root: string;
  private ledger: DeviceLedger;
  private scope: string;
  private worker?: Worker;
  private workerConfiguration?: WorkerConfiguration;
  private observation?: ObservationConfig;
  private desktopPermissions?: Awaited<ReturnType<typeof probeComputer>>;
  private nextDesktopProbe = 0;
  private workspaceIdentity: string;
  private claimId = randomUUID();
  private readonly worktrees?: Awaited<ReturnType<typeof gitRunWorktrees>>;

  constructor(base: URL, token: string, root: string, ledger: DeviceLedger, worker?: Worker, observation?: ObservationConfig, workspaceIdentity = root,
              worktrees?: Awaited<ReturnType<typeof gitRunWorktrees>>) {
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) {
      throw new Error('Router URL must use HTTPS or local loopback HTTP.');
    }
    this.socket = new DeviceSocket(base, token);
    this.root = root;
    this.workspaceIdentity = workspaceIdentity;
    this.ledger = ledger;
    this.worker = worker;
    this.worktrees = worktrees;
    if (worker) {
      const protocol = worker.protocol ?? 'acp';
      const adapterVersion = 1;
      // Keep executable paths and arguments local, even if they contain sensitive values.
      const revision = createHmac('sha256', token).update(JSON.stringify([
        adapterVersion, worker.label, protocol, worker.executable, worker.args, worker.env ?? [],
        worker.protocol === 'jsonl' && worker.includeFullInputArtifacts === true,
        ...(worktrees ? ['git-worktree', worktrees.includePatch] : []),
      ])).digest('hex');
      const capabilities: WorkerCapability[] = [];
      if (worktrees) capabilities.push('git-worktree');
      if (protocol === 'codex') capabilities.push('read-only');
      if (protocol === 'codex' || protocol === 'pi') capabilities.push('steer');
      if (worker.protocol === 'jsonl' && worker.includeFullInputArtifacts) capabilities.push('full-input-artifacts');
      this.workerConfiguration = { label: worker.label, protocol, adapterVersion, revision,
        ...(capabilities.length && { capabilities }) };
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
    if (this.observation && performance.now() >= this.nextDesktopProbe) {
      this.desktopPermissions = await probeComputer(this.observation, this.root,
        AbortSignal.any([signal, AbortSignal.timeout(3_000)])).catch(() => undefined);
      this.nextDesktopProbe = performance.now() + 30_000;
      signal.throwIfAborted();
    }
    const claimStarted = performance.now();
    const observation = this.observation;
    const claim = await this.post('claim', {
      capability: this.observation ? 'computer.observe' : this.worker ? 'agent.acp' : 'document.preview', requestId: this.claimId, platform: platform(),
      worker: this.workerConfiguration,
      desktopPermissions: this.desktopPermissions,
      desktopApps: observation ? [...observation.apps.keys()] : undefined,
      desktopControls: observation ? [...observation.apps.keys()].map(alias => ({
        alias, buttons: [...observation.buttons?.get(alias) ?? []], visual: observation.visualApps?.has(alias) === true,
      })) : undefined,
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
        if (assignment.readOnlyRequired && this.worker?.protocol !== 'codex') {
          throw new Error('This device cannot enforce the read-only Worker requirement');
        }
        if (this.observation) {
          outcome = await executeDesktopAction(this.observation, this.root, assignment.task.goal, active,
            async (summary, signal) => {
              const decision = await this.approve(prefix, summary, signal);
              if (decision?.decision !== 'approved') return undefined;
              return () => this.consumeApproval(prefix, decision.id, signal);
            }, assignment.clickExpectedText);
        } else if (this.worker) {
          const root = this.worktrees ? await this.worktrees.prepare(assignment.run.id) : this.root;
          active.throwIfAborted();
          const { result, checkpoint: session } = await executeWorker({
            root, scope: this.scope, workspaceIdentity: this.worktrees ? root : this.workspaceIdentity,
            revision: this.workerConfiguration?.revision, ledger: this.ledger,
            post: (path, data, signal) => this.post(path, data, signal),
            approve: (path, summary, signal) => this.approve(path, summary, signal),
            consumeApproval: (path, id, signal) => this.consumeApproval(path, id, signal),
          }, this.worker, prefix, assignment.task.id, {
            goal: assignment.task.goal, instructions: assignment.instructions, predecessors: assignment.predecessors,
            acceptanceCriteria: assignment.acceptanceCriteria, memoryInputs: assignment.memoryInputs, attachments: assignment.attachments,
          }, stop, active, assignment.fullInputRequired);
          checkpoint = this.worktrees ? undefined : session;
          let artifact = { name: 'worker-result.txt', text: result };
          if (this.worktrees) {
            try {
              artifact = await this.worktrees.artifact(assignment.run.id, active);
            } catch {
              active.throwIfAborted();
              throw new Error('The Worker finished but its Git evidence is unavailable. Inspect the retained checkout.');
            }
          }
          outcome = { status: 'succeeded', result, artifact };
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
        outcome = { status: error instanceof DesktopResultUnverified ? 'waiting_user' : 'failed', result: error instanceof Error ? error.message : 'Preview failed' };
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
