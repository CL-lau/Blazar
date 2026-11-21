import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPi } from '../../packages/workers/pi.ts';
import type { WorkerSteer } from '../../packages/workers/prompt.ts';
import { resolveWorker } from '../../packages/workers/registry.ts';

const executable = process.env.BLAZAR_TEST_PI_EXECUTABLE;

test('Pi applies a steering message with a local mock provider', {
  skip: !executable && 'Set BLAZAR_TEST_PI_EXECUTABLE to an installed pi executable',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'blazar-pi-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  });
  const instruction = 'Use the latest instructions';
  const requests: string[] = [];
  const firstRequest = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    if (requests.length === 1) {
      firstRequest.resolve();
      await firstResponse.promise;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (choices: object[]) => response.write('data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices,
    }) + '\n\n');
    const content = body.includes(instruction) ? 'PI_STEER_OK' : 'Initial reply';
    emit([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]);
    emit([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    firstResponse.resolve();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    api: 'openai-completions', apiKey: 'local-fixture', models: [{ id: 'fixture-model' }],
  } } }));
  const worker = await resolveWorker('pi', undefined, executable);
  assert(worker?.protocol === 'pi');
  const signal = AbortSignal.timeout(15_000);
  const ready = Promise.withResolvers<WorkerSteer>();
  const result = runPi({ ...worker, args: [...worker.args, '--provider', 'fixture', '--model', 'fixture-model'] },
    root, { goal: 'Pi steering smoke test', instructions: [], predecessors: [] }, signal, steer => {
      ready.resolve(steer);
      return () => {};
    });
  const steer = await Promise.race([ready.promise, result.then(() => { throw new Error('Pi finished before steering'); })]);
  await Promise.race([firstRequest.promise, result]);
  const applied = steer(instruction, 'fixture-revision-2');
  firstResponse.resolve();
  assert.equal(await result, 'PI_STEER_OK');
  assert.equal(await applied, true);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0], /Use the latest instructions/);
  assert.match(requests[1], /Use the latest instructions/);
});
