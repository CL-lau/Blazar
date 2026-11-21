import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeAcp, runAcp } from '../../packages/workers/acp.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_KIMI_EXECUTABLE;

test('Kimi completes, restores, and cancels ACP tasks with a local OpenAI endpoint', {
  skip: !executable && 'Set BLAZAR_TEST_KIMI_EXECUTABLE to an installed kimi executable',
}, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'blazar-kimi-runtime-')));
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
    if (body.includes('Cancel this Kimi fixture run')) {
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
        choices: [{ index: 0, message: { role: 'assistant', content: 'KIMI_ACP_OK' }, finish_reason: 'stop' }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: 'KIMI_ACP_OK' }, finish_reason: null }],
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
  const state = join(workspace, 'state');
  await mkdir(state);
  await writeFile(join(state, 'config.toml'), `
default_model = "fixture"
telemetry = false
auto_session_title = false

[providers.fixture]
type = "openai"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "fixture-token"

[models.fixture]
provider = "fixture"
model = "gpt-4o-mini"
max_context_size = 128000
capabilities = ["tool_use"]
`);
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
  });
  const worker = await resolveWorker('kimi', undefined, executable);
  assert(worker?.label === 'Kimi Code' && worker.protocol === undefined);
  const signal = AbortSignal.timeout(45_000);
  const capabilities = await probeAcp(worker, workspace, signal);
  assert.equal(capabilities.version, 1);
  assert.ok(capabilities.loadSession || capabilities.resumeSession);
  let session: string | undefined;
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Kimi ACP smoke test', instructions: ['Return the fixture response'], predecessors: [],
  }, signal, undefined, undefined, { onCompleted: id => { session = id; } }), 'KIMI_ACP_OK');
  const firstPrompt = prompts.find(body => body.includes('Return the fixture response'));
  assert.ok(firstPrompt);
  assert.equal(JSON.parse(firstPrompt).stream, true);
  assert.ok(session);
  assert.equal(await runAcp(worker, workspace, {
    goal: 'Continue the Kimi fixture', instructions: [], predecessors: [],
  }, signal, undefined, undefined, { resumeId: session }), 'KIMI_ACP_OK');
  assert.ok(prompts.find(body => body.includes('Continue the Kimi fixture'))?.includes('Return the fixture response'));
  const stop = new AbortController();
  const interrupted = assert.rejects(runAcp(worker, workspace, {
    goal: 'Cancel this Kimi fixture run', instructions: [], predecessors: [],
  }, AbortSignal.any([signal, stop.signal])), { name: 'AbortError' });
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await Promise.race([streaming.promise, deadline]);
  stop.abort();
  await interrupted;
  await Promise.race([streamClosed.promise, deadline]);
});
