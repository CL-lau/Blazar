import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

test('scheduled workflows survive restart and run through normal claims and approval gates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'blazar-workflow-schedule-'));
  const db = join(directory, 'router.sqlite');
  let store = new TaskStore(db);
  const server = routerServer(store, { owner: 'owner', token: 'local' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const nextAt = Date.now() + 60_000;
  const input = { workspace: 'project', label: 'Daily review', nextAt, intervalMinutes: 1, steps: [
    { key: 'draft', goal: 'Draft summary', needs: [], requireReview: true },
    { key: 'archive', goal: 'Archive summary', needs: ['draft'] },
  ] };
  const api = new URL('http://127.0.0.1:' + address.port + '/v1/admin/workflow-schedules');
  const headers = { Authorization: 'Bearer local', 'Content-Type': 'application/json', 'Idempotency-Key': 'daily-review' };
  const add = (data: object) => fetch(api, { method: 'POST', headers, body: JSON.stringify(data) });
  let id: string;
  try {
    const first = await add(input);
    assert.equal(first.status, 201);
    ({ id } = await first.json() as { id: string });
    assert.deepEqual(await (await add(input)).json(), { id });
    assert.equal((await add({ ...input, label: 'Different schedule' })).status, 409);
  } finally {
    server.closeDeviceSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  store.close();
  store = new TaskStore(db);
  assert.equal(store.dispatchDueWorkflows(nextAt - 1), 0);
  assert.equal(store.dispatchDueWorkflows(nextAt), 1);
  assert.equal(store.dispatchDueWorkflows(nextAt), 0);
  assert.equal(store.workflowSchedules('owner')[0].id, id);
  const now = Date.now();
  const device = store.registerDevice('owner', 'Worker', 'project');
  const first = store.claim('owner', 'project', device.id, now, 45_000)!;
  assert.equal(first.task.goal, 'Draft summary');
  assert(store.finish(first.run.id, device.id, now, { status: 'succeeded', result: 'Summary' }));
  const pending = store.get('owner', first.task.id)!;
  assert.equal(pending.status, 'waiting_review');
  assert.equal(store.dispatchDueWorkflows(nextAt + 120_000), 0);
  assert.equal(store.claim('owner', 'project', device.id, now, 45_000), undefined);
  assert.equal(store.command('owner', first.task.id, pending.version, { action: 'accept_result' })?.status, 'succeeded');
  const next = store.claim('owner', 'project', device.id, now, 45_000)!;
  assert.equal(next.task.goal, 'Archive summary');
  assert.equal(next.predecessors[0].result, 'Summary');
  assert(store.finish(next.run.id, device.id, now, { status: 'succeeded', result: 'Archived' }));
  assert.equal(store.dispatchDueWorkflows(nextAt + 120_000), 1);
  assert.equal(store.workflowSchedules('owner')[0].nextAt, nextAt + 180_000);
  assert.equal(store.snapshot('owner').tasks.length, 4);
  const second = store.claim('owner', 'project', device.id, now, 45_000)!;
  assert(store.finish(second.run.id, device.id, now, { status: 'failed', result: 'Worker unavailable' }));
  const failed = store.get('owner', second.task.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(store.dispatchDueWorkflows(nextAt + 180_000), 0);
  const retry = store.command('owner', failed.id, failed.version, { action: 'retry' })!;
  assert.equal(retry.status, 'queued');
  assert.equal(store.command('owner', retry.id, retry.version, { action: 'cancel' })?.status, 'cancelled');
  assert.equal(store.disableWorkflowSchedule('other', id), false);
  assert.equal(store.disableWorkflowSchedule('owner', id), true);
  assert.equal(store.dispatchDueWorkflows(nextAt + 240_000), 0);
});
