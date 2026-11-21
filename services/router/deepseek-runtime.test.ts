import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deepSeekWorker, runAcp } from '../../packages/workers/acp.ts';

const executable = process.env.BLAZAR_TEST_DEEPSEEK_EXECUTABLE;

test('DeepSeek Harness completes an ACP task with a local mock provider', {
  skip: !executable && 'Set BLAZAR_TEST_DEEPSEEK_EXECUTABLE to an installed dsh executable',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'blazar-deepseek-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const previousHome = process.env.DSH_HOME;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DSH_HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });
  const requests: { path?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/messages') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body });
    const { model } = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type: string, data: object) =>
      response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    emit('message_start', { message: {
      id: 'fixture', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'DEEPSEEK_SMOKE_OK' } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    emit('message_stop', {});
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await writeFile(join(home, '.env'), 'DEEPSEEK_API_KEY=local-fixture\nDEEPSEEK_BASE_URL=http://127.0.0.1:' + address.port + '\n');
  const output = await runAcp({ ...deepSeekWorker, executable: executable! }, workspace, {
    goal: 'DeepSeek mock prompt', instructions: ['Use the test response'], predecessors: [],
  }, AbortSignal.timeout(15_000));
  assert.equal(output, 'DEEPSEEK_SMOKE_OK');
  assert.equal(requests.length, 1);
  assert.match(requests[0].body, /Use the test response/);
});
