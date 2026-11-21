import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_OPENCODE_EXECUTABLE;

test('OpenCode completes an ACP task with a local mock provider', {
  skip: !executable && 'Set BLAZAR_TEST_OPENCODE_EXECUTABLE to an installed opencode executable',
}, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'blazar-opencode-runtime-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const settings = {
    XDG_CONFIG_HOME: join(workspace, 'config'), XDG_DATA_HOME: join(workspace, 'data'),
    XDG_STATE_HOME: join(workspace, 'state'), XDG_CACHE_HOME: join(workspace, 'cache'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
  const prior = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: 'OPENCODE_ACP_OK' }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ]) {
      response.write('data: ' + JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices,
      }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await writeFile(join(workspace, 'opencode.json'), JSON.stringify({
    model: 'fixture/fixture-model', permission: { '*': 'deny' }, autoupdate: false,
    provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', name: 'Local fixture',
      options: { baseURL: 'http://127.0.0.1:' + address.port + '/v1', apiKey: 'local-fixture' },
      models: { 'fixture-model': { name: 'Fixture model' } },
    } },
  }));
  const preset = await resolveWorker('opencode', undefined, executable);
  assert(preset?.label === 'OpenCode');
  const worker = { ...preset, env: Object.keys(settings) };
  const signal = AbortSignal.timeout(25_000);
  assert.equal((await probeAcp(worker, workspace, signal)).version, 1);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'OpenCode ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal), 'OPENCODE_ACP_OK');
  assert.ok(requests.some(body => body.includes('Return the fixture response')));
});
