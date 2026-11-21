import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from './store.ts';

const workerCount = 10;
const owner = 'topology';
const workspaces = ['design', 'engineering', 'operations'];
const arrivals = Array.from({ length: 200 }, (_, index) => {
  const workspace = workspaces[index % workspaces.length];
  return { id: index, workspace, bound: index % 3 !== 0, goal: 'Review fixture ' + index };
}).flatMap((event, index) => index < 100 ? [event, event] : [event]);
const fixtures = new Map(arrivals.map(event => [event.goal, event]));
const modelDelayMs = 4;
const executionDelayMs = 2;
type Topology = 'single-session' | 'two-layer' | 'subscription-direct';

function p95(values: number[]) {
  return Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(2));
}

async function run(topology: Topology) {
  const directory = await mkdtemp(join(tmpdir(), 'blazar-topology-'));
  const store = new TaskStore(join(directory, 'router.sqlite'));
  const started = performance.now();
  const available = new Map<string, number>();
  const first = new Map<number, Promise<void>>();
  const receipts: number[] = [];
  const boundReceipts: number[] = [];
  const boundClaims: number[] = [];
  const claims: number[] = [];
  const accepted = new Set<string>();
  let modelRequests = 0;
  const deviceIds = Array.from({ length: workerCount }, (_, i) => 'topology-worker-' + i);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]);
  const subscriptions = new EventEmitter();
  let singleSession = Promise.resolve();
  let delivered = 0;

  async function execute(device: string) {
    signal.throwIfAborted();
    for (const workspace of workspaces) {
      const assignment = store.claim(owner, workspace, device, Date.now(), 45_000, '', '/preview ',
        undefined, { label: 'Topology fixture', protocol: 'jsonl', capabilities: ['git-worktree'] });
      if (!assignment) continue;
      const { run, task } = assignment;
      const expected = fixtures.get(task.goal);
      assert(expected && expected.workspace === task.workspace && !accepted.has(task.id), 'Incorrect or duplicate assignment');
      accepted.add(task.id);
      const latency = performance.now() - available.get(task.id)!;
      claims.push(latency);
      if (expected.bound) boundClaims.push(latency);
      await delay(executionDelayMs, undefined, { signal });
      assert.equal(store.finish(run.id, device, Date.now(), { status: 'succeeded', result: task.goal }), true);
      delivered++;
      return true;
    }
    return false;
  }

  const workers = topology === 'single-session' ? [] : deviceIds.map(async device => {
    while (delivered < fixtures.size) {
      if (!await execute(device)) await delay(1, undefined, { signal });
    }
  });
  try {
    function persist(event: typeof arrivals[number], received: number) {
      const task = store.create(owner, 'desktop', 'fixture-' + event.id, event.workspace, event.goal);
      available.set(task.id, received);
      if (event.bound) {
        assert.equal(task.status, 'queued');
        const elapsed = performance.now() - received;
        boundReceipts.push(elapsed);
      }
    }
    for (const workspace of workspaces) subscriptions.on(workspace, persist);
    async function receive(event: typeof arrivals[number]) {
      const received = performance.now();
      let pending = first.get(event.id);
      if (!pending) {
        const route = async () => {
          signal.throwIfAborted();
          if (topology === 'subscription-direct' && event.bound) {
            assert(subscriptions.emit(event.workspace, event, received));
            return;
          }
          if (topology === 'single-session' || !event.bound) {
            modelRequests++;
            await delay(modelDelayMs, undefined, { signal });
          }
          persist(event, received);
        };
        pending = topology === 'single-session' ? singleSession.then(route) : route();
          if (topology === 'single-session') {
            singleSession = pending.then(async () => { assert(await execute(deviceIds[0])); });
            void singleSession.catch(() => {});
          }
        first.set(event.id, pending);
      }
      await pending;
      receipts.push(performance.now() - received);
    }
    const ingress = (async () => {
      const requests = [];
      for (let offset = 0; offset < arrivals.length; offset += workerCount) {
        for (const event of arrivals.slice(offset, offset + workerCount)) {
          const request = receive(event);
          void request.catch(() => {});
          requests.push(request);
        }
        await delay(5, undefined, { signal });
      }
      await Promise.all(requests);
      await singleSession;
    })();
    const active = [ingress, ...workers];
    try { await Promise.all(active); }
    catch (error) {
      stop.abort();
      await Promise.allSettled(active);
      throw error;
    }
    assert.equal(receipts.length, 300);
    assert.equal(accepted.size, 200);
    assert.equal(delivered, 200);
    assert.equal(store.snapshot(owner).tasks.length, 200);
    return { topology, executionConcurrency: topology === 'single-session' ? 1 : workerCount,
      requests: receipts.length, duplicateRequests: receipts.length - first.size, delivered, modelRequests,
      acknowledgementP95Ms: p95(receipts), claimP95Ms: p95(claims), boundAcknowledgementP95Ms: p95(boundReceipts),
      boundRunnableP95Ms: p95(boundReceipts), boundClaimP95Ms: p95(boundClaims), elapsedMs: Math.round(performance.now() - started) };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const results = [];
for (const topology of ['single-session', 'two-layer', 'subscription-direct'] as const) results.push(await run(topology));
console.log(JSON.stringify({ cpu: cpus()[0]?.model, node: process.version, workerCount, modelDelayMs, executionDelayMs, results }, null, 2));
