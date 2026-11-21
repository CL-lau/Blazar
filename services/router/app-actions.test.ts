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
