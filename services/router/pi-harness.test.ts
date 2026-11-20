import assert from 'node:assert/strict';
import test from 'node:test';
import { piHarness } from './harness.ts';

function providerStream(text: string) {
  const item = {
    type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item] } },
  ];
  return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('Pi Core routes from supplied personal memory and aborts a pending provider request', async t => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-key';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  let requestNumber = 0;
  let requestBody = '';
  const waiting = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, '/v1/responses');
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
    requestBody = await request.text();
    if (++requestNumber === 1) return providerStream(JSON.stringify({ kind: 'reply', text: 'Three bullets.' }));
    return new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      waiting.resolve();
    });
  });

  const route = piHarness('openai', 'gpt-5-mini');
  const input = {
    workspace: 'project', text: 'What is my preferred format?', recent: [],
    usePersonalMemory: true as const, personalMemory: ['The report format is three bullets.'],
  };
  const decision = await route(input, AbortSignal.timeout(3000));
  assert.deepEqual(decision, { kind: 'reply', text: 'Three bullets.' });
  assert.match(requestBody, /The report format is three bullets/);
  assert.equal(JSON.parse(requestBody).tools?.length ?? 0, 0);
  const stop = new AbortController();
  const cancelled = assert.rejects(route(input, stop.signal), /aborted/i);
  await waiting.promise;
  stop.abort();
  await cancelled;
});
