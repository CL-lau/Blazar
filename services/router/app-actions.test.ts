import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeApplicationAction, type ActionBackend, type ApplicationAction } from '../../packages/apps/actions.ts';

const action: ApplicationAction = {
  connectionId: 'account-one', capability: 'document.update', invocationId: 'operation-1', effect: 'write', input: {},
};

test('application actions authorize matching fallback backends separately', async () => {
  const visited: string[] = [];
  const primary: ActionBackend = {
    ...action, id: 'api', async invoke() { return { status: 'unavailable-before-dispatch' }; },
  };
  const fallback: ActionBackend = {
    ...action, id: 'browser', async invoke() { return { status: 'succeeded', output: 'updated' }; },
  };
  const otherAccount = { ...fallback, id: 'other-account', connectionId: 'account-two' };
  const outcome = await invokeApplicationAction(action, [primary, otherAccount, fallback], async backend => {
    visited.push(backend.id);
    return backend.id !== 'browser';
  }, new AbortController().signal);
  assert.deepEqual(visited, ['api', 'browser']);
  assert.deepEqual(outcome, { status: 'denied' });
  assert.deepEqual(await invokeApplicationAction(action, [primary, fallback], async () => true,
    new AbortController().signal), { status: 'succeeded', output: 'updated' });
});

test('application writes stop at the backend with an ambiguous outcome', async () => {
  const primary: ActionBackend = {
    ...action, id: 'api', async invoke() { throw new Error('Connection lost after dispatch'); },
  };
  const outcome = await invokeApplicationAction(action, [primary, { ...primary, id: 'browser' }], async backend => {
    assert.equal(backend.id, 'api');
    return true;
  }, new AbortController().signal);
  assert.deepEqual(outcome, { status: 'outcome-unknown', backendId: 'api' });
});

test('MCP writes fall back after failed initialization and stop after a failed tool call', async () => {
  const { mcpActionBackend } = await import('../../packages/apps/mcp-actions.ts');
  const requests: string[] = [];
  let failDuring: 'initialize' | 'tools/call' = 'initialize';
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const { method, id, params } = JSON.parse(String(init?.body));
    requests.push(path + ':' + method);
    if (path === '/primary' && method === failDuring) return new Response(null, { status: 503 });
    if (method === 'initialize') return Response.json({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(method, 'tools/call');
    assert.deepEqual(params, { name: 'update_document', arguments: { title: 'Approved title' } });
    return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'updated' }] } });
  };
  const backends = ['primary', 'backup'].map(id => mcpActionBackend({
    id, connectionId: action.connectionId, capability: action.capability, effect: 'write',
    endpoint: 'http://127.0.0.1:4198/' + id, tool: 'update_document',
  }, fetcher));
  const run = () => invokeApplicationAction({ ...action, input: { title: 'Approved title' } },
    backends, async () => true, AbortSignal.timeout(5_000));

  assert.deepEqual(await run(), { status: 'succeeded', output: { content: [{ type: 'text', text: 'updated' }] } });
  assert.deepEqual(requests, ['/primary:initialize', '/backup:initialize',
    '/backup:notifications/initialized', '/backup:tools/call']);
  requests.length = 0;
  failDuring = 'tools/call';
  assert.deepEqual(await run(), { status: 'outcome-unknown', backendId: 'primary' });
  assert.deepEqual(requests, ['/primary:initialize', '/primary:notifications/initialized', '/primary:tools/call']);
});

test('approved writes preserve their dispatch claim across Router restarts', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { MemoryStore } = await import('./memory.ts');
  const { confirmApplicationWrite } = await import('./application/app-write.ts');
  const directory = await mkdtemp(join(tmpdir(), 'blazar-app-write-'));
  const path = join(directory, 'memory.sqlite');
  let memory = new MemoryStore(path);
  t.after(async () => {
    memory.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connectionId = memory.connect('owner', 'mcp', 'handbook', 'project');
  const propose = () => memory.appWrites.propose('owner', 'project',
    { ...action, connectionId }, 'revision-one', Date.now() + 30_000);
  const id = propose();
  const interruptedId = propose();
  assert.ok(id && interruptedId);
  const signal = AbortSignal.timeout(5_000);
  let sent = 0;
  const backend: ActionBackend = {
    ...action, connectionId, id: 'api',
    async invoke(request) {
      assert.equal(request.invocationId, id);
      sent++;
      throw new Error('Lost response');
    },
  };
  const confirm = (proposal: string, revision = 'revision-one', owner = 'owner') =>
    confirmApplicationWrite(memory.appWrites, owner, proposal, revision, [backend], signal);
  await assert.rejects(confirm(id, 'revision-two'), /configuration changed/);
  await assert.rejects(confirm(id, 'revision-one', 'other'), /not found/);
  assert.deepEqual(await confirm(id), { status: 'outcome_unknown' });
  assert.equal(memory.appWrites.get('owner', id)?.backend, 'api');
  assert.equal(memory.appWrites.claim('owner', interruptedId, 'revision-one'), true);
  const revokedId = propose();
  assert.ok(revokedId);
  assert.equal(memory.disconnect('owner', connectionId), true);
  await assert.rejects(confirm(revokedId), /access or configuration changed/);
  memory.close();
  memory = new MemoryStore(path);
  assert.deepEqual(await confirm(id), { status: 'outcome_unknown' });
  assert.deepEqual(await confirm(interruptedId), { status: 'dispatching' });
  assert.equal(sent, 1);
});

test('Router requires explicit confirmation for a configured application write', async t => {
  const { once } = await import('node:events');
  const { routerServer } = await import('./http.ts');
  const { TaskStore } = await import('./store.ts');
  const { MemoryStore } = await import('./memory.ts');
  const { configuredApplicationWrites } = await import('../../packages/apps/config.ts');
  const memory = new MemoryStore(':memory:');
  const store = new TaskStore(':memory:');
  const connection = memory.connect('owner', 'mcp', 'Handbook', 'project');
  const calls: string[] = [];
  const definitions = configuredApplicationWrites({
    BLAZAR_MCP_ACTIONS: JSON.stringify([{
      app: 'mcp', account: 'Handbook', capability: 'action.document.update',
      endpoint: 'http://127.0.0.1:4198/mcp', tool: 'update_document',
    }]),
  }, async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    if (method === 'initialize') return Response.json({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(method, 'tools/call');
    assert.deepEqual(params, { name: 'update_document', arguments: { title: 'Approved' } });
    return Response.json({ jsonrpc: '2.0', id, result: { content: [] } });
  });
  const router = routerServer(store, { memory, owner: 'owner', token: 'fixture', applicationWrites: definitions });
  router.listen(0, '127.0.0.1');
  await once(router, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => router.close(() => resolve()));
    memory.close();
    store.close();
  });
  const address = router.address();
  assert(address && typeof address !== 'string');
  const request = (path: string, method: string, body?: object, token = 'fixture') =>
    fetch('http://127.0.0.1:' + address.port + path, { method, signal: AbortSignal.timeout(5_000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await request('/v1/app-connections/' + connection + '/write-proposals', 'POST', {
    workspace: 'project', capability: 'action.document.update', input: { title: 'Approved' },
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const proposal = '/v1/app-write-proposals/' + id;
  assert.deepEqual((await (await request(proposal, 'GET')).json()).input, { title: 'Approved' });
  assert.equal((await request(proposal + '/confirm', 'POST', undefined, 'wrong')).status, 401);
  assert.deepEqual(calls, []);
  const confirmations = await Promise.all([request(proposal + '/confirm', 'POST'), request(proposal + '/confirm', 'POST')]);
  assert.deepEqual(confirmations.map(response => response.status), [200, 200]);
  await Promise.all(confirmations.map(response => response.json()));
  assert.equal((await (await request(proposal, 'GET')).json()).status, 'succeeded');
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/call']);
});
