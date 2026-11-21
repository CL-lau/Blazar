import type { Run, Task } from '../../packages/protocol/task.ts';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from '../device/preview.ts';
import { DeviceSocket } from '../device/socket.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';
import { feishuChannel } from '../../packages/channels/feishu.ts';

const mixed = process.argv.includes('--mixed');
const jobs = 200;
const duplicates = 100;
const concurrency = 10;
const workspace = 'benchmark';
const timeout = AbortSignal.timeout(30_000);
const stop = new AbortController();
const active = AbortSignal.any([timeout, stop.signal]);
const root = await realpath(await mkdtemp(join(tmpdir(), 'blazar-bench-')));
const store = new TaskStore(join(root, 'router.sqlite'));
const token = randomBytes(32).toString('hex');
const feishu = {
  token: 'benchmark-verification', appId: 'benchmark-app', tenant: 'benchmark-tenant', workspace,
  senders: new Set(['benchmark-user']), chats: new Set(['benchmark-chat']),
};
const server = routerServer(store, {
  owner: 'benchmark', token, feishu,
  ...(mixed && { harness: async () => ({ kind: 'create_task' as const }) }),
});
const connections: DeviceSocket[] = [];
const opened = new Map<string, number>();
const accepted = new Set<string>();
const intakePaths = ['/v1/events', '/v1/conversation', '/v1/channels/feishu/events'] as const;
const reception = intakePaths.map(() => ({ first: [] as number[], replay: [] as number[] }));
const dispatch: number[] = [];
const cancellations: number[] = [];

function p95(values: number[]) {
  return Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(2));
}

try {
  if (!mixed) await Promise.all(Array.from({ length: jobs }, (_, index) =>
    writeFile(join(root, index + '.md'), 'Fixture ' + index)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = new URL('http://127.0.0.1:' + address.port);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (let index = 0; index < concurrency; index++) {
    const device = store.registerDevice('benchmark', 'Device ' + index, workspace);
    connections.push(new DeviceSocket(base, device.token));
  }

  async function send(index: number, replay = false) {
    const goal = mixed ? 'Review fixture ' + index : '/preview ' + index + '.md';
    const key = 'fixture-' + index;
    const channel = index % 3;
    const started = performance.now();
    if (!opened.has(goal)) opened.set(goal, started);
    const webhook = {
      schema: '2.0', header: {
        token: feishu.token, app_id: feishu.appId, tenant_key: feishu.tenant, event_type: 'im.message.receive_v1',
      },
      event: {
        sender: { sender_id: { open_id: 'benchmark-user' }, sender_type: 'user' },
        message: { message_id: key, chat_id: 'benchmark-chat', message_type: 'text',
          content: JSON.stringify({ text: '/blazar ' + goal }) },
      },
    };
    const path = intakePaths[channel];
    const response = await fetch(new URL(path, base), {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, signal: active,
      body: JSON.stringify(channel === 2 ? webhook : { workspace, text: goal }),
    });
    assert.equal(response.status, channel === 2 ? 200 : 202);
    await response.arrayBuffer();
    reception[channel][replay ? 'replay' : 'first'].push(performance.now() - started);
  }

  async function taskCommand(task: Task, key: string, command: { action: 'cancel' } | { action: 'approve'; approvalId: string }) {
    const response = await fetch(new URL('/v1/tasks/' + task.id + '/commands', base), {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, signal: active,
      body: JSON.stringify({ expectedVersion: task.version, ...command }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  const started = performance.now();
  const staging = Array.from({ length: concurrency }, (_, sender) => (async () => {
    for (let index = sender; index < jobs; index += concurrency) {
      await send(index);
      if (index < duplicates) await send(index, true);
    }
  })());
  const workers = connections.map(async socket => {
    while (accepted.size < jobs) {
      active.throwIfAborted();
      const claim = await socket.request('claim', {
        ...(mixed ? { capability: 'agent.acp', worker: { protocol: 'jsonl', label: 'Benchmark fixture' } }
          : { capability: 'document.preview' }),
        requestId: randomUUID(),
      }, active);
      assert.equal(claim.status, 200);
      const { assignment } = await claim.json() as { assignment: { run: Run; task: Task } | null };
      if (!assignment) {
        await delay(5, undefined, { signal: active });
        continue;
      }
      const { run, task } = assignment;
      assert.equal(task.workspace, workspace);
      assert(opened.has(task.goal), 'Unexpected goal reached a device');
      assert(!accepted.has(task.goal), 'Task was claimed more than once');
      dispatch.push(performance.now() - opened.get(task.goal)!);
      accepted.add(task.goal);
      const index = Number(mixed ? task.goal.slice('Review fixture '.length) : task.goal.slice(9, -3));
      const text = mixed ? 'Fixture ' + index : await preview(root, task.goal, active);
      assert.equal(text, 'Fixture ' + index);
      if (mixed && index % 10 === 0) {
        const prefix = 'runs/' + run.id + '/';
        const requested = await socket.request(prefix + 'request-approval', { summary: 'Review benchmark fixture' }, active);
        assert.equal(requested.status, 200);
        const { approval } = await requested.json() as { approval: { id: string } };
        await taskCommand(task, 'approval-' + index, { action: 'approve', approvalId: approval.id });
        const consumed = await socket.request(prefix + 'consume-approval', { approvalId: approval.id }, active);
        assert.equal(consumed.status, 200);
      }
      const outcome = { status: 'succeeded', result: text };
      const finish = () => socket.request('runs/' + run.id + '/finish', outcome, active);
      if (mixed && index % 10 === 1) {
        const startedCancel = performance.now();
        const stopped = Promise.withResolvers<boolean>();
        const unwatch = socket.onStop(run.id, () => stopped.resolve(true));
        const deadline = setTimeout(() => stopped.resolve(false), 2_000);
        try {
          await taskCommand(task, 'cancel-' + index, { action: 'cancel' });
          assert.equal(await stopped.promise, true, 'Cancellation stop did not reach the device');
          assert.equal((await socket.request('runs/' + run.id + '/stopped', {}, active)).status, 200);
          cancellations.push(performance.now() - startedCancel);
          assert.equal((await finish()).status, 409);
        } finally {
          clearTimeout(deadline);
          unwatch();
        }
        continue;
      }
      assert.equal((await finish()).status, 200);
      if (accepted.size % 10 === 0) assert.equal((await finish()).status, 200);
    }
  });

  const batch = [...staging, ...workers];
  try {
    await Promise.all(batch);
  } catch (error) {
    stop.abort();
    await Promise.allSettled(batch);
    throw error;
  }
  const state = store.snapshot('benchmark');
  assert.equal(state.tasks.length, jobs);
  const expectedCancelled = mixed ? jobs / 10 : 0;
  assert.equal(cancellations.length, expectedCancelled);
  for (const task of state.tasks) {
    assert.equal(task.status, mixed && Number(task.goal.slice('Review fixture '.length)) % 10 === 1
      ? 'cancelled' : 'succeeded');
  }
  let cursor = 0;
  let finishes = 0;
  let approvals = 0;
  for (;;) {
    const events = store.events('benchmark', cursor);
    if (!events.length) break;
    finishes += events.filter(event => event.type === 'run.finished').length;
    approvals += events.filter(event => event.type === 'approval.decided').length;
    cursor = events.at(-1)!.seq;
  }
  assert.equal(finishes, jobs - expectedCancelled);
  assert.equal(approvals, mixed ? jobs / 10 : 0);
  const notices = new Set<string>();
  for (;;) {
    const notice = store.leaseChannelNotice(feishuChannel(feishu), Date.now());
    if (!notice) break;
    assert(!notices.has(notice.messageId), 'Duplicate notification staged for delivery');
    notices.add(notice.messageId);
    store.finishChannelNotice(notice.id, true);
  }
  assert.equal(notices.size, Math.floor(jobs / 3));

  const response = await fetch(new URL('/v1/admin/metrics', base), { headers, signal: active });
  const serverMetrics = await response.json() as { routing: { model: number } };
  assert.equal(serverMetrics.routing.model, mixed ? Math.floor((jobs + 1) / 3) : 0);
  const firstReceipts = reception.flatMap(group => group.first);
  const replayReceipts = reception.flatMap(group => group.replay);
  assert.equal(firstReceipts.length, jobs);
  assert.equal(replayReceipts.length, duplicates);
  assert.equal(dispatch.length, jobs);
  const receiptP95Ms = p95([...firstReceipts, ...replayReceipts]);
  const firstReceiptP95Ms = p95(firstReceipts);
  const receiptByPath = Object.fromEntries(intakePaths.map((path, index) => {
    const { first, replay } = reception[index];
    return [path, { firstRequests: first.length, firstP95Ms: p95(first), replayRequests: replay.length, replayP95Ms: p95(replay) }];
  }));
  const claimP95Ms = p95(dispatch);
  console.log(JSON.stringify({
    workload: mixed ? 'mock-worker-with-approvals-and-cancellations' : 'document-preview',
    approvals, cpu: cpus()[0]?.model, node: process.version, concurrency, submitted: firstReceipts.length + replayReceipts.length,
    completed: finishes, cancelled: cancellations.length,
    cancelToStopP95Ms: cancellations.length ? p95(cancellations) : null, duplicateTasks: 0, duplicateOutboundNotices: 0, unexpectedAssignments: 0,
    modelRequests: serverMetrics.routing.model, receiptP95Ms, firstReceiptP95Ms, claimP95Ms, receiptByPath,
    elapsedMs: Math.round(performance.now() - started),
  }, null, 2));
  assert(firstReceiptP95Ms < 100, 'First local acknowledgement p95 exceeded 100 ms');
  assert(claimP95Ms < 250, 'Local claim p95 exceeded 250 ms');
} finally {
  stop.abort();
  for (const socket of connections) socket.close();
  server.closeDeviceSockets();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  await rm(root, { recursive: true, force: true });
}
