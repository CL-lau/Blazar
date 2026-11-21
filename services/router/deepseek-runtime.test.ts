import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWorker } from '../../packages/workers/registry.ts';
import { DeviceClient } from '../device/client.ts';
import { DeviceLedger } from '../device/ledger.ts';
import { routerServer } from './http.ts';
import { TaskStore } from './store.ts';

const executable = process.env.BLAZAR_TEST_DEEPSEEK_EXECUTABLE;

test('DeepSeek Harness completes an ACP task with a local mock provider', {
  skip: !executable && 'Set BLAZAR_TEST_DEEPSEEK_EXECUTABLE to an installed dsh executable',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'blazar-deepseek-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const previousHome = process.env.DSH_HOME;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DSH_HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const { model } = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type: string, data: object) =>
      response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    emit('message_start', { message: {
      id: 'fixture', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'DEEPSEEK_SMOKE_OK' } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    emit('message_stop', {});
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await writeFile(join(home, '.env'), 'DEEPSEEK_API_KEY=local-fixture\nDEEPSEEK_BASE_URL=http://127.0.0.1:' + address.port + '\n');
  const worker = await resolveWorker('deepseek', undefined, executable);
  assert.equal(worker?.label, 'DeepSeek Harness');
  const store = new TaskStore(':memory:');
  const ledger = new DeviceLedger(':memory:');
  const router = routerServer(store, { owner: 'owner', token: 'test-token' });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  const routerAddress = router.address();
  assert(routerAddress && typeof routerAddress !== 'string');
  const base = new URL('http://127.0.0.1:' + routerAddress.port);
  const device = store.registerDevice('owner', 'DeepSeek device', 'project');
  const client = new DeviceClient(base, device.token, workspace, ledger, worker);
  t.after(async () => {
    client.close();
    router.closeDeviceSockets();
    await new Promise<void>(resolve => router.close(() => resolve()));
    ledger.close();
    store.close();
  });
  const signal = AbortSignal.timeout(15_000);
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const post = (path: string, key: string, body: object) => fetch(new URL(path, base), {
    method: 'POST', signal, headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body),
  });
  const creation = await post('/v1/events', 'create-deepseek', { workspace: 'project', text: 'DeepSeek mock prompt' });
  assert.equal(creation.status, 202);
  const { id } = await creation.json();
  const append = await post('/v1/tasks/' + id + '/commands', 'append-deepseek', {
    action: 'append', expectedVersion: 1, text: 'Use the test response',
  });
  assert.equal(append.status, 200);
  assert.equal(await client.runOnce(signal), true);
  assert.equal(store.get('owner', id)?.status, 'succeeded');
  assert.equal(store.get('owner', id)?.result, 'DEEPSEEK_SMOKE_OK');
  const { artifacts } = store.snapshot('owner');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].taskId, id);
  const artifact = await fetch(new URL('/v1/artifacts/' + artifacts[0].id, base), { headers, signal });
  assert.equal(artifact.status, 200);
  assert.equal(await artifact.text(), 'DEEPSEEK_SMOKE_OK');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /Use the test response/);
});
