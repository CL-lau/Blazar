import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_GOOSE_EXECUTABLE;

test('Goose completes, restores, and cancels ACP tasks with a local OpenAI endpoint', {
  skip: !executable && 'Set BLAZAR_TEST_GOOSE_EXECUTABLE to an installed goose executable',
}, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'blazar-goose-runtime-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const prompts: string[] = [];
  const streaming = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer fixture-token') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { stream?: boolean; model?: string };
    prompts.push(body);
    if (body.includes('Cancel this Goose fixture run')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.once('close', () => streamClosed.resolve());
      streaming.resolve();
      return;
    }
    const common = { id: 'fixture', created: 1, model: input.model };
    const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
    if (!input.stream) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...common, object: 'chat.completion', usage,
        choices: [{ index: 0, message: { role: 'assistant', content: 'GOOSE_ACP_OK' }, finish_reason: 'stop' }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: 'GOOSE_ACP_OK' }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ]) {
      response.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices }) + '\n\n');
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
    GOOSE_PATH_ROOT: join(workspace, 'state'), GOOSE_DISABLE_KEYRING: 'true',
    GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'gpt-4o-mini', GOOSE_FAST_MODEL: 'gpt-4o-mini',
    OPENAI_HOST: 'http://127.0.0.1:' + address.port, OPENAI_BASE_PATH: 'v1/chat/completions', OPENAI_API_KEY: 'fixture-token',
  };
  const previous = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const worker = await resolveWorker('goose', undefined, executable);
  assert(worker?.label === 'Goose' && worker.protocol === undefined);
  const signal = AbortSignal.timeout(25_000);
  const capabilities = await probeAcp(worker, workspace, signal);
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.loadSession || capabilities.resumeSession);
  let session: string | undefined;
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Goose ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal, undefined, undefined, { onCompleted: id => { session = id; } }), 'GOOSE_ACP_OK');
  const firstPrompt = prompts.find(body => body.includes('Return the fixture response'));
  assert.ok(firstPrompt);
  assert.equal(JSON.parse(firstPrompt).stream, true);
  assert.ok(session);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Continue the Goose fixture', instructions: [], predecessors: [],
  }, signal, undefined, undefined, { resumeId: session }), 'GOOSE_ACP_OK');
  assert.ok(prompts.find(body => body.includes('Continue the Goose fixture'))?.includes('Return the fixture response'));
  const stop = new AbortController();
  const interrupted = assert.rejects(runAcp(worker, workspace, {
    goal: 'Cancel this Goose fixture run', instructions: [], predecessors: [],
  }, AbortSignal.any([signal, stop.signal])), { name: 'AbortError' });
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await Promise.race([streaming.promise, deadline]);
  stop.abort();
  await interrupted;
  await Promise.race([streamClosed.promise, deadline]);
});
