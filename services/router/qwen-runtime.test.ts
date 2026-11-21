import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_QWEN_EXECUTABLE;

test('Qwen Code completes, restores, authorizes reads, and cancels ACP tasks', {
  skip: !executable && 'Set BLAZAR_TEST_QWEN_EXECUTABLE to an installed qwen executable',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'blazar-qwen-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const qwenConfig = join(root, 'config');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(qwenConfig), mkdir(workspace)]);
  const fixtureFile = join(workspace, 'review.txt');
  await writeFile(fixtureFile, 'QWEN_APPROVED_FILE_CONTENT');

  const prompts: string[] = [];
  let toolRequested = false;
  const streaming = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer fixture-token') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    prompts.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.includes('Cancel this fixture run')) {
      response.flushHeaders();
      response.once('close', () => streamClosed.resolve());
      streaming.resolve();
      return;
    }
    const useTool = body.includes('Read the approval fixture') && !toolRequested;
    if (useTool) toolRequested = true;
    const choices = useTool ? [
      [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_read',
        type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: fixtureFile }) } }] },
        finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    ] : [
      [{ index: 0, delta: { role: 'assistant', content: 'QWEN_ACP_OK' }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ];
    for (const chunk of choices) {
      response.write('data: ' + JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: chunk,
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
  const settings = {
    QWEN_HOME: qwenConfig, QWEN_RUNTIME_DIR: join(root, 'runtime'),
    OPENAI_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1',
    OPENAI_API_KEY: 'fixture-token', OPENAI_MODEL: 'fixture-model', QWEN_CODE_MODELS_DEV_REFRESH: 'off',
  };
  const previous = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(qwenConfig, 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'openai' } },
    permissions: { ask: ['ReadFile'] },
    general: { enableAutoUpdate: false }, telemetry: { enabled: false },
  }));
  const worker = await resolveWorker('qwen', undefined, executable);
  assert(worker?.label === 'Qwen Code' && worker.protocol === undefined);
  const signal = AbortSignal.timeout(30_000);
  const capabilities = await probeAcp(worker, workspace, signal);
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.loadSession || capabilities.resumeSession);
  let session: string | undefined;
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Qwen Code ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal, undefined, undefined, { onCompleted: id => { session = id; } }), 'QWEN_ACP_OK');
  assert.ok(prompts.some(body => body.includes('Return the fixture response')));
  assert.ok(session);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Continue the fixture conversation', instructions: [], predecessors: [],
  }, signal, undefined, undefined, { resumeId: session, onCompleted: id => assert.equal(id, session) }), 'QWEN_ACP_OK');
  const resumed = prompts.find(body => body.includes('Continue the fixture conversation'));
  assert.ok(resumed?.includes('Return the fixture response'), 'Restored model context must include the previous user turn');
  const approvals: string[] = [];
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Read the approval fixture', instructions: [], predecessors: [],
  }, signal, async summary => {
    approvals.push(summary);
    return 'approved';
  }), 'QWEN_ACP_OK');
  assert.equal(approvals.length, 1);
  assert.match(approvals[0], /"review\.txt"/);
  assert.ok(prompts.some(body => body.includes('QWEN_APPROVED_FILE_CONTENT')));
  const firstDeniedPrompt = prompts.length;
  toolRequested = false;
  await assert.rejects(runAcp(worker, workspace, {
    goal: 'Read the approval fixture without approval', instructions: [], predecessors: [],
  }, signal, async summary => {
    approvals.push(summary);
    return 'denied';
  }), /did not return a completed response/);
  assert.equal(approvals.length, 2);
  assert.ok(!prompts.slice(firstDeniedPrompt).some(body => body.includes('QWEN_APPROVED_FILE_CONTENT')));
  const stop = new AbortController();
  const interrupted = assert.rejects(runAcp(worker, workspace, {
    goal: 'Cancel this fixture run', instructions: [], predecessors: [],
  }, AbortSignal.any([signal, stop.signal])), { name: 'AbortError' });
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await Promise.race([streaming.promise, deadline]);
  stop.abort();
  await interrupted;
  await Promise.race([streamClosed.promise, deadline]);
});
