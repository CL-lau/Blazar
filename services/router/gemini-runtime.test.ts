import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_GEMINI_EXECUTABLE;

test('Gemini CLI completes, restores, and cancels ACP tasks with a local Gemini API', {
  skip: !executable && 'Set BLAZAR_TEST_GEMINI_EXECUTABLE to an installed gemini executable',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'blazar-gemini-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config', '.gemini');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(config, { recursive: true }), mkdir(workspace)]);
  const prompts: string[] = [];
  const streaming = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith('/v1beta/models/') || request.headers['x-goog-api-key'] !== 'fixture-token') {
      response.writeHead(404).end();
      return;
    }
    if (request.url.includes(':countTokens')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ totalTokens: 12 }));
      return;
    }
    if (!request.url.includes(':streamGenerateContent')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    prompts.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.includes('Cancel this Gemini fixture run')) {
      response.flushHeaders();
      response.once('close', () => streamClosed.resolve());
      streaming.resolve();
      return;
    }
    response.end('data: ' + JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'GEMINI_ACP_OK' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    }) + '\n\n');
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
    GEMINI_CLI_HOME: join(root, 'config'), GEMINI_API_KEY: 'fixture-token',
    GEMINI_MODEL: 'gemini-2.5-flash',
    GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:' + address.port,
    GEMINI_TELEMETRY_ENABLED: 'false',
  };
  const previous = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(config, 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key' } },
    general: { enableAutoUpdate: false }, telemetry: { enabled: false },
  }));
  const worker = await resolveWorker('gemini', undefined, executable);
  assert(worker?.label === 'Gemini CLI' && worker.protocol === undefined);
  const signal = AbortSignal.timeout(25_000);
  const capabilities = await probeAcp(worker, workspace, signal);
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.loadSession || capabilities.resumeSession);
  let session: string | undefined;
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Gemini ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal, undefined, undefined, { onCompleted: id => { session = id; } }), 'GEMINI_ACP_OK');
  assert.ok(prompts.some(body => body.includes('Return the fixture response')));
  assert.ok(session);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Continue the Gemini fixture', instructions: [], predecessors: [],
  }, signal, undefined, undefined, { resumeId: session }), 'GEMINI_ACP_OK');
  assert.ok(prompts.find(body => body.includes('Continue the Gemini fixture'))?.includes('Return the fixture response'));
  const stop = new AbortController();
  const interrupted = assert.rejects(runAcp(worker, workspace, {
    goal: 'Cancel this Gemini fixture run', instructions: [], predecessors: [],
  }, AbortSignal.any([signal, stop.signal])), { name: 'AbortError' });
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await Promise.race([streaming.promise, deadline]);
  stop.abort();
  await interrupted;
  await Promise.race([streamClosed.promise, deadline]);
});
