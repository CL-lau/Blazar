import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAider } from '../../packages/workers/aider.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_AIDER_EXECUTABLE;

test('Aider returns model output from a local OpenAI-compatible endpoint', {
  skip: !executable && 'Set BLAZAR_TEST_AIDER_EXECUTABLE to an installed aider executable',
}, async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'blazar-aider-fixture-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer local-fixture') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: 'fixture', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
      choices: [{
        index: 0, message: { role: 'assistant', content: 'AIDER_SMOKE_OK\nSecond line' }, finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
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
    AIDER_MODEL: 'openai/gpt-4o-mini', AIDER_OPENAI_API_BASE: 'http://127.0.0.1:' + address.port + '/v1',
    OPENAI_API_KEY: 'local-fixture', LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  };
  const prior = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const worker = await resolveWorker('aider', undefined, executable);
  assert(worker?.protocol === 'aider');
  assert.equal(await runAider({ ...worker, env: [...worker.env ?? [], 'LITELLM_LOCAL_MODEL_COST_MAP'] }, workspace, {
    goal: 'Aider smoke test', instructions: ['Use the fixture response'], predecessors: [],
  }, AbortSignal.timeout(40_000)), 'AIDER_SMOKE_OK\nSecond line');
  assert.ok(requests.some(body => body.includes('Use the fixture response')));
});
