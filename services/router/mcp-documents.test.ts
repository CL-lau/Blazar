import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredDocuments } from '../../packages/apps/config.ts';

test('a configured MCP account reads allowlisted text resources without invoking tools', async () => {
  const methods: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:4198/mcp');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'DELETE') {
      assert.equal(new Headers(init.headers).get('mcp-session-id'), 'fixture-session');
      methods.push('close');
      return new Response(null, { status: 204 });
    }
    const { method, id, params } = JSON.parse(String(init?.body));
    methods.push(method);
    if (method === 'initialize') return Response.json({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion, capabilities: { resources: {} },
      serverInfo: { name: 'fixture', version: '1' },
    } }, { headers: { 'Mcp-Session-Id': 'fixture-session' } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(method, 'resources/read');
    assert.equal(params.uri, 'docs://handbook/review');
    return Response.json({ jsonrpc: '2.0', id, result: { contents: [
      { uri: params.uri, mimeType: 'text/plain', text: 'MCP review guidance' },
      { uri: 'docs://other/resource', text: 'Unrelated content' },
    ] } });
  };
  const [connector] = configuredDocuments({
    BLAZAR_MCP_DOCS: JSON.stringify([{
      account: 'handbook', endpoint: 'http://127.0.0.1:4198/mcp', tokenEnv: 'BLAZAR_MCP_TOKEN_HANDBOOK',
      resources: { review: 'docs://handbook/review' },
    }]),
    BLAZAR_MCP_TOKEN_HANDBOOK: 'fixture-token',
  }, transport);
  assert.equal(connector.app, 'mcp');
  const signal = AbortSignal.timeout(2_000);
  assert.equal(connector.accepts('docs://handbook/review'), false);
  await assert.rejects(connector.read('unlisted', signal), /Unknown MCP resource alias/);
  assert.deepEqual(methods, []);
  const content = await connector.read('review', signal);
  assert.equal(content.text, 'MCP review guidance');
  assert.match(content.revision, /^sha256:/);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'resources/read', 'close']);
});
