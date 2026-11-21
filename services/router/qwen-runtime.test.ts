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

test('Qwen Code completes an ACP task using the configured local model', {
  skip: !executable && 'Set BLAZAR_TEST_QWEN_EXECUTABLE to an installed qwen executable',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'blazar-qwen-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const qwenConfig = join(root, 'config');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(qwenConfig), mkdir(workspace)]);

  const prompts: string[] = [];
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
    const choices = [
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
    general: { enableAutoUpdate: false }, telemetry: { enabled: false },
  }));
  const worker = await resolveWorker('qwen', undefined, executable);
  assert(worker?.label === 'Qwen Code' && worker.protocol === undefined);
  const signal = AbortSignal.timeout(30_000);
  assert.equal((await probeAcp(worker, workspace, signal)).version, 1);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Qwen Code ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal), 'QWEN_ACP_OK');
  assert.ok(prompts.some(body => body.includes('Return the fixture response')));
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
