import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_OPENCODE_EXECUTABLE;

test('OpenCode restores and cancels ACP tasks and rejects permissions without file locations', {
  skip: !executable && 'Set BLAZAR_TEST_OPENCODE_EXECUTABLE to an installed opencode executable',
}, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'blazar-opencode-runtime-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fixtureFile = join(workspace, 'review.txt');
  await writeFile(fixtureFile, 'OPENCODE_APPROVED_FILE_CONTENT');
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
  let toolRequested = false;
  const streaming = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tools = (JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools;
    const hasReadTool = tools?.some(tool => tool.function?.name === 'read');
    if (hasReadTool && body.includes('Cancel this OpenCode fixture run')) {
      response.flushHeaders();
      response.once('close', () => streamClosed.resolve());
      streaming.resolve();
      return;
    }
    const useTool = hasReadTool && body.includes('Read the OpenCode approval fixture') && !toolRequested;
    if (useTool) toolRequested = true;
    const chunks = useTool ? [
      [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_read', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ filePath: fixtureFile }) } }] }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    ] : [
      [{ index: 0, delta: { role: 'assistant', content: 'OPENCODE_ACP_OK' }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ];
    for (const choices of chunks) {
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
    model: 'fixture/fixture-model', permission: { '*': 'deny', read: 'ask' }, autoupdate: false,
    provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', name: 'Local fixture',
      options: { baseURL: 'http://127.0.0.1:' + address.port + '/v1', apiKey: 'local-fixture' },
      models: { 'fixture-model': { name: 'Fixture model' } },
    } },
  }));
  const worker = await resolveWorker('opencode', undefined, executable);
  assert(worker?.label === 'OpenCode');
  const signal = AbortSignal.timeout(25_000);
  const capability = await probeAcp(worker, workspace, signal);
  assert.equal(capability.version, 1);
  assert.ok(capability.loadSession || capability.resumeSession);
  let session: string | undefined;
  assert.equal(await runAcp(worker, workspace, {
    goal: 'OpenCode ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal, undefined, undefined, { onCompleted: id => { session = id; } }), 'OPENCODE_ACP_OK');
  assert.ok(requests.some(body => body.includes('Return the fixture response')));
  assert.ok(session);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Continue the OpenCode fixture', instructions: [], predecessors: [],
  }, signal, undefined, undefined, { resumeId: session }), 'OPENCODE_ACP_OK');
  assert.ok(requests.find(body => body.includes('Continue the OpenCode fixture'))?.includes('Return the fixture response'));
  let approvalRequests = 0;
  await assert.rejects(runAcp(worker, workspace, {
    goal: 'Read the OpenCode approval fixture', instructions: [], predecessors: [],
  }, signal, async () => {
    approvalRequests++;
    return 'approved';
  }), /requested file access without identifying the file/);
  assert.equal(approvalRequests, 0);
  assert.equal(toolRequested, true);
  assert.ok(!requests.some(body => body.includes('OPENCODE_APPROVED_FILE_CONTENT')));
  const stop = new AbortController();
  const interrupted = assert.rejects(runAcp(worker, workspace, {
    goal: 'Cancel this OpenCode fixture run', instructions: [], predecessors: [],
  }, AbortSignal.any([signal, stop.signal])), { name: 'AbortError' });
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await Promise.race([streaming.promise, deadline]);
  stop.abort();
  await interrupted;
  await Promise.race([streamClosed.promise, deadline]);
});
