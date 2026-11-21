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
  const interrupted = memory.appWrites.get('owner', interruptedId);
  assert.ok(interrupted);
  assert.equal(memory.appWrites.reconcile('owner', interruptedId, 'not_applied', 'External audit', interrupted.expires), false);
  assert.equal(memory.appWrites.reconcile('owner', interruptedId, 'not_applied', 'External audit', interrupted.expires + 10_000), true);
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
  let loseToolResponse = false;
  let reportCorrectInvocation = false;
  const dispatchedIds: string[] = [];
  const definitions = configuredApplicationWrites({
    BLAZAR_MCP_ACTIONS: JSON.stringify([{
      app: 'mcp', account: 'Handbook', capability: 'action.document.update',
      endpoint: 'http://127.0.0.1:4198/mcp', tool: 'update_document', statusTool: 'lookup_update',
      fallbacks: [{ endpoint: 'http://127.0.0.1:4198/backup', tool: 'update_document', statusTool: 'lookup_update' }],
    }]),
  }, async (url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    const fallback = String(url).endsWith('/backup');
    if (loseToolResponse && !fallback && method === 'initialize') return new Response(null, { status: 503 });
    if (method === 'initialize') return Response.json({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(method, 'tools/call');
    if (params.name === 'lookup_update') {
      assert.equal(fallback, true);
      assert.deepEqual(Object.keys(params.arguments), ['blazarInvocationId']);
      assert.ok(dispatchedIds.includes(params.arguments.blazarInvocationId));
      return Response.json({ jsonrpc: '2.0', id, result: { content: [], structuredContent: {
        resolution: 'applied', evidence: 'External revision 42 confirms the title',
        blazarInvocationId: reportCorrectInvocation ? params.arguments.blazarInvocationId : 'different-write',
      } } });
    }
    assert.equal(params.name, 'update_document');
    assert.equal(params.arguments.title, 'Approved');
    dispatchedIds.push(params.arguments.blazarInvocationId);
    if (loseToolResponse) {
      assert.equal(fallback, true);
      return new Response(null, { status: 503 });
    }
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
  const create = () => request('/v1/app-connections/' + connection + '/write-proposals', 'POST', {
    workspace: 'project', capability: 'action.document.update', input: { title: 'Approved' },
  });
  const created = await create();
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

  const evidence = { resolution: 'applied', evidence: 'External revision 42 confirms the title' };
  assert.equal((await request(proposal + '/reconcile', 'POST', evidence)).status, 409);
  loseToolResponse = true;
  const uncertainId = (await (await create()).json()).id;
  const uncertain = '/v1/app-write-proposals/' + uncertainId;
  const pair = (name: string) => store.redeemPairing(store.createPairing('owner', Date.now()).code, name, Date.now());
  const iphone = pair('iPhone');
  const other = pair('Other iPhone');
  assert.ok(iphone && other);
  assert.equal((await request(uncertain, 'GET', undefined, iphone.token)).status, 404);
  assert.equal((await request(uncertain + '/share', 'POST', { client: iphone.id })).status, 200);
  const available = await (await request('/v1/app-write-proposals', 'GET', undefined, iphone.token)).json();
  assert.deepEqual(available.proposals.map((item: { id: string }) => item.id), [uncertainId]);
  assert.equal((await request(uncertain, 'GET', undefined, other.token)).status, 404);
  const shared = await (await request(uncertain, 'GET', undefined, iphone.token)).json();
  assert.deepEqual(shared.input, { title: 'Approved' });
  assert.equal(shared.connection, undefined);
  assert.equal(shared.account, 'Handbook');
  assert.deepEqual(JSON.parse(shared.inputPreview), shared.input);
  assert.equal((await request(uncertain + '/reconcile', 'POST', evidence, iphone.token)).status, 404);
  assert.equal((await request(uncertain + '/share', 'POST', { client: null })).status, 200);
  assert.equal((await request(uncertain + '/confirm', 'POST', undefined, iphone.token)).status, 404);
  assert.equal((await request(uncertain + '/share', 'POST', { client: iphone.id })).status, 200);
  assert.deepEqual(await (await request(uncertain + '/confirm', 'POST', undefined, iphone.token)).json(), { status: 'outcome_unknown' });
  assert.deepEqual(dispatchedIds, [id, uncertainId]);
  assert.equal(memory.appWrites.get('owner', uncertainId)?.backend, 'mcp-1');
  assert.equal((await request(uncertain + '/check-result', 'POST', {}, iphone.token)).status, 404);
  assert.deepEqual(await (await request(uncertain + '/check-result', 'POST')).json(), { reconciliation: null });
  reportCorrectInvocation = true;
  const reconciled = await request(uncertain + '/check-result', 'POST');
  assert.equal(reconciled.status, 200);
  const { reconciliation: record } = await reconciled.json();
  assert.equal(record.evidence, evidence.evidence);
  assert.deepEqual((await (await request(uncertain, 'GET')).json()).reconciliation, record);
  assert.equal((await request(uncertain + '/reconcile', 'POST', { ...evidence, resolution: 'not_applied' })).status, 409);
  assert.deepEqual(await (await request(uncertain + '/confirm', 'POST')).json(), { status: 'outcome_unknown' });
  assert.equal(calls.filter(method => method === 'tools/call').length, 4);
  assert.equal(dispatchedIds.length, 2);
});

test('a browser form fallback submits approved data once after MCP is unavailable', {
  skip: !process.env.BLAZAR_TEST_BROWSER_ACTIONS,
}, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { configuredApplicationWrites } = await import('../../packages/apps/config.ts');
  const received: string[] = [];
  const app = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/edit') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<form method="post" action="/save"><label>Title <input name="title"></label><button>Save</button></form>');
    } else if (request.method === 'POST' && request.url === '/save') {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.end('Saved');
    } else response.writeHead(404).end();
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise<void>(resolve => app.close(() => resolve())));
  const address = app.address();
  assert(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const [definition] = configuredApplicationWrites({ BLAZAR_MCP_ACTIONS: JSON.stringify([{
    app: 'mcp', account: 'fixture', capability: 'action.document.update', endpoint: base + '/mcp', tool: 'update',
    fallbacks: [{ kind: 'browser-form', url: base + '/edit', submitUrl: base + '/save',
      button: 'Save', inputLabel: 'Title', inputKey: 'title' }],
  }]) }, async () => new Response(null, { status: 503 }));
  const backends = definition.candidates.map(({ backend }) => ({ ...backend, connectionId: action.connectionId }));
  const run = (allowWrite: boolean) => {
    let browserChecks = 0;
    return invokeApplicationAction({ ...action, capability: definition.capability, input: { title: 'Approved title' } },
      backends, async backend => backend.id !== 'browser-1' || ++browserChecks === 1 || allowWrite,
      AbortSignal.timeout(10_000));
  };
  assert.deepEqual(await run(false), { status: 'denied' });
  assert.deepEqual(received, []);
  assert.deepEqual(await run(true), { status: 'succeeded', output: { status: 200 } });
  assert.deepEqual(received, ['title=Approved+title']);
});
