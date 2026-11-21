import assert from 'node:assert/strict';
import test from 'node:test';
import { piHarness } from './harness.ts';
import { TaskStore } from './store.ts';

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

function lookupStream() {
  const call = {
    type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture',
    name: 'find_tasks', arguments: JSON.stringify({ query: 'decision' }), status: 'completed',
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_lookup' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_lookup', status: 'completed', output: [call] } },
  ];
  return new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('Pi Core looks up task status without receiving results from other owners or workspaces', async t => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture-key';
  const store = new TaskStore(':memory:');
  t.after(() => {
    store.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const allowed = store.create('local', 'test', 'one', 'project', 'Draft decision');
  store.create('local', 'test', 'two', 'another', 'Private workspace decision');
  store.create('another', 'test', 'one', 'project', 'Private owner decision');
  let requests = 0;
  let neverAnswer = false;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).text();
    assert.match(body, /find_tasks/);
    if (++requests === 1 || neverAnswer) return lookupStream();
    assert.match(body, new RegExp(allowed.id));
    assert.doesNotMatch(body, /Private workspace|Private owner/);
    return providerStream(JSON.stringify({ kind: 'reply', text: 'The task is queued.' }));
  });
  const route = piHarness('openai', 'gpt-5-mini');
  const input = {
    workspace: 'project', text: 'What is the status of the decision?', recent: [],
    findTasks: (query: string) => store.findRouterTasks('local', 'project', query),
  };
  const answer = await route(input, AbortSignal.timeout(3_000));
  assert.deepEqual(answer, { kind: 'reply', text: 'The task is queued.' });
  assert.equal(requests, 2);
  requests = 0;
  neverAnswer = true;
  await assert.rejects(route(input, AbortSignal.timeout(3_000)), /budget|did not complete/);
  assert.equal(requests, 2);
});

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
