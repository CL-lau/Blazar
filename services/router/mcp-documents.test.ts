import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredDocuments } from '../../packages/apps/config.ts';
import { invokeDocumentCapability } from './application/document-sync.ts';
import { MemoryStore } from './memory.ts';
import { documentAppCatalog } from '../../packages/apps/documents.ts';

test('a configured MCP account reads allowlisted text resources without invoking tools', async t => {
  const methods: string[] = [];
  const primary = 'http://127.0.0.1:4198/primary';
  let primaryStatus = 503;
  let githubStatus = 200;
  const transport: typeof fetch = async (input, init) => {
    if (String(input) === 'https://api.github.com/repos/example/handbook/contents/docs/review.md') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer github-token');
      methods.push('github');
      return new Response(githubStatus === 200 ? 'GitHub review guidance' : null, { status: githubStatus });
    }
    if (String(input) === primary) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer primary-token');
      methods.push('primary');
      return new Response(null, { status: primaryStatus });
    }
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
    if (method === 'resources/list') return Response.json({ jsonrpc: '2.0', id, result: params?.cursor
      ? { resources: [{ uri: 'docs://handbook/review', name: 'Review' }] }
      : { resources: [{ uri: 'docs://private/unlisted', name: 'Private' }], nextCursor: 'next' } });
    assert.equal(method, 'resources/read');
    assert.equal(params.uri, 'docs://handbook/review');
    return Response.json({ jsonrpc: '2.0', id, result: { contents: [
      { uri: params.uri, mimeType: 'text/plain', text: 'MCP review guidance' },
      { uri: 'docs://other/resource', text: 'Unrelated content' },
    ] } });
  };
  const account = {
    account: 'handbook', endpoint: 'http://127.0.0.1:4198/mcp', tokenEnv: 'BLAZAR_MCP_TOKEN_HANDBOOK',
    resources: { review: 'docs://handbook/review' },
  };
  const custom = { ...account, version: 1, connector: 'mcp-resources', id: 'custom.handbook', label: 'Team Handbook',
    endpoint: primary, tokenEnv: 'BLAZAR_MCP_TOKEN_PRIMARY', fallbacks: [{ endpoint: account.endpoint, tokenEnv: account.tokenEnv }] };
  const env = {
    BLAZAR_MCP_DOCS: JSON.stringify([account]),
    BLAZAR_APP_MANIFESTS: JSON.stringify([custom]),
    BLAZAR_MCP_TOKEN_HANDBOOK: 'fixture-token',
    BLAZAR_MCP_TOKEN_PRIMARY: 'primary-token',
  };
  const [connector, extension] = configuredDocuments(env, transport);
  assert.equal(extension.app, 'custom.handbook');
  const definition = documentAppCatalog([connector, extension]).find(app => app.id === extension.app);
  assert.equal(definition?.label, 'Team Handbook');
  assert.equal(definition?.version, 1);
  assert.deepEqual(definition?.accounts, ['handbook']);
  assert.throws(() => configuredDocuments({ ...env, BLAZAR_APP_MANIFESTS: JSON.stringify([{ ...custom, version: 2 }]) }),
    /Invalid application manifest/);
  assert.throws(() => configuredDocuments({ ...env, BLAZAR_APP_MANIFESTS: JSON.stringify([custom, custom]) }),
    /Duplicate document account/);
  assert.equal(connector.app, 'mcp');
  assert.deepEqual(connector.documentAliases, ['review']);
  const signal = AbortSignal.timeout(2_000);
  assert.equal(connector.accepts('docs://handbook/review'), false);
  await assert.rejects(connector.read('unlisted', signal), /Unknown MCP resource alias/);
  assert.deepEqual(methods, []);
  const content = await extension.read('review', signal);
  assert.equal(content.text, 'MCP review guidance');
  assert.match(content.revision, /^sha256:/);
  assert.deepEqual(methods, ['primary', 'initialize', 'notifications/initialized', 'resources/read', 'close']);
  methods.length = 0;
  primaryStatus = 403;
  await assert.rejects(extension.read('review', signal), /denied access/);
  assert.deepEqual(methods, ['primary']);
  methods.length = 0;
  primaryStatus = 503;
  const store = new MemoryStore(':memory:');
  t.after(() => store.close());
  const connection = store.connect('owner', extension.app, extension.account, 'project');
  const discover = (workspace: string) =>
    invokeDocumentCapability(store, 'owner', connection, [extension], 'document.discover', { workspace });
  await assert.rejects(discover('other'), /Active connection not found/);
  assert.deepEqual(methods, []);
  assert.deepEqual(await discover('project'), { aliases: ['review'], complete: true });
  assert.deepEqual(methods, ['primary', 'initialize', 'notifications/initialized', 'resources/list', 'resources/list', 'close']);
  methods.length = 0;
  assert.deepEqual(await invokeDocumentCapability(store, 'owner', connection, [extension], 'connection.health',
    { workspace: 'project' }), { status: 'succeeded' });
  assert.deepEqual(methods, ['primary', 'initialize', 'notifications/initialized', 'resources/list', 'close']);
  store.revokeResource('owner', connection, 'review');
  assert.deepEqual(await discover('project'), { aliases: [], complete: true });
  const changed = {
    ...extension,
    async discover() {
      store.setConnectionWorkspace('owner', connection, 'other');
      store.setConnectionWorkspace('owner', connection, 'project');
      throw new Error('Stale backend response');
    },
  };
  await assert.rejects(invokeDocumentCapability(store, 'owner', connection, [changed], 'document.discover',
    { workspace: 'project' }), /Source access changed during discovery/);

  const githubManifest = { version: 1, connector: 'github-documents', id: 'custom.repository',
    label: 'Repository handbook', account: 'handbook', repository: 'example/handbook',
    tokenEnv: 'BLAZAR_GITHUB_TOKEN_HANDBOOK', documents: { review: 'docs/review.md' },
    fallbacks: [{ endpoint: account.endpoint, tokenEnv: account.tokenEnv, resources: account.resources }] };
  const githubEnv = { ...env, BLAZAR_GITHUB_TOKEN_HANDBOOK: 'github-token' };
  assert.throws(() => configuredDocuments({ ...githubEnv, BLAZAR_APP_MANIFESTS: JSON.stringify([{
    ...githubManifest, fallbacks: [{ ...githubManifest.fallbacks[0], resources: { other: 'docs://handbook/other' } }],
  }]) }, transport), /exactly the configured document aliases/);
  const [repository] = configuredDocuments({ ...githubEnv, BLAZAR_MCP_DOCS: '[]',
    BLAZAR_APP_MANIFESTS: JSON.stringify([githubManifest]) }, transport);
  methods.length = 0;
  assert.equal((await repository.read('review', signal)).text, 'GitHub review guidance');
  assert.deepEqual(methods, ['github']);
  methods.length = 0;
  githubStatus = 401;
  await assert.rejects(repository.read('review', signal), /no longer has access/);
  assert.deepEqual(methods, ['github']);
  methods.length = 0;
  githubStatus = 503;
  assert.equal((await repository.read('review', signal)).text, 'MCP review guidance');
  assert.deepEqual(methods, ['github', 'initialize', 'notifications/initialized', 'resources/read', 'close']);

});
