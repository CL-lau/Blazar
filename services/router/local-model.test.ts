import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { piHarness } from './harness.ts';
import { localModelProvider } from './local-model.ts';

test('Router sends an inference request to the configured local API', async t => {
  let received: unknown;
  let path: string | undefined;
  const server = createServer(async (request, response) => {
    path = request.url;
    let body = '';
    for await (const part of request) body += part;
    received = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '{"kind":"reply","text":"Local answer"}' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const previous = process.env.BLAZAR_LOCAL_MODEL_URL;
  process.env.BLAZAR_LOCAL_MODEL_URL = 'http://127.0.0.1:' + address.port + '/v1';
  t.after(() => {
    if (previous === undefined) delete process.env.BLAZAR_LOCAL_MODEL_URL;
    else process.env.BLAZAR_LOCAL_MODEL_URL = previous;
  });

  const harness = piHarness('local', 'fixture-model');
  const answer = await harness({ workspace: 'default', text: 'Say hello', recent: [] }, AbortSignal.timeout(5_000));
  assert.equal(path, '/v1/chat/completions');
  assert.equal((received as { model: string }).model, 'fixture-model');
  assert.deepEqual(answer, { kind: 'reply', text: 'Local answer' });
  assert.throws(() => localModelProvider('fixture-model', 'http://example.com/v1'), /loopback/);
});
