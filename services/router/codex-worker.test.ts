import assert from 'node:assert/strict';
import test from 'node:test';
import { runCodex } from '../../packages/workers/codex.ts';

test('Codex correlates stream events with the started turn even before the RPC response', async () => {
  const worker = {
    executable: process.execPath, label: 'Codex protocol fixture',
    args: ['-e', String.raw`
      const { createInterface } = require('node:readline');
      const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const { id, method } = JSON.parse(line);
        const reply = result => send({ id, result });
        const notify = (method, params) => send({ method, params: { threadId: 'thread', ...params } });
        if (method === 'initialize') reply({});
        if (method === 'thread/start') reply({ thread: { id: 'thread' } });
        if (method === 'turn/start') {
          notify('item/agentMessage/delta', { turnId: 'other', delta: 'Unrelated' });
          notify('turn/completed', { turn: { id: 'other', status: 'completed' } });
          notify('item/agentMessage/delta', { turnId: 'active', delta: 'Early ' });
          reply({ turn: { id: 'active' } });
          notify('item/agentMessage/delta', { turnId: 'active', delta: 'reply' });
          notify('turn/completed', { turn: { id: 'active', status: 'completed' } });
        }
      });
    `],
  };
  const job = { goal: 'Review the notes', instructions: [], predecessors: [] };
  assert.equal(await runCodex(worker, process.cwd(), job, AbortSignal.timeout(3_000)), 'Early reply');
});

test('Codex steers the active turn with a correlated user message', async () => {
  const worker = {
    executable: process.execPath, label: 'Codex steering fixture',
    args: ['-e', String.raw`
      const assert = require('node:assert/strict');
      const send = packet => process.stdout.write(JSON.stringify(packet) + '\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        const reply = result => send({ id, result });
        if (method === 'initialize') reply({});
        if (method === 'thread/start') reply({ thread: { id: 'thread' } });
        if (method === 'turn/start') reply({ turn: { id: 'active' } });
        if (method === 'turn/steer') {
          assert.equal(params.threadId, 'thread');
          assert.equal(params.expectedTurnId, 'active');
          assert.equal(params.clientUserMessageId, 'message-2');
          reply({ turnId: 'active' });
          send({ method: 'item/agentMessage/delta', params: {
            threadId: 'thread', turnId: 'active', delta: params.input[0].text,
          } });
          send({ method: 'turn/completed', params: {
            threadId: 'thread', turn: { id: 'active', status: 'completed' },
          } });
        }
      });
    `],
  };
  const job = { goal: 'Review the notes', instructions: [], predecessors: [] };
  const accepted = Promise.withResolvers<boolean>();
  let cleared = false;
  const output = await runCodex(worker, process.cwd(), job, AbortSignal.timeout(3_000), steer => {
    accepted.resolve(steer('Include the latest notes', 'message-2'));
    return () => { cleared = true; };
  });
  assert.equal(await accepted.promise, true);
  assert.equal(output, 'Include the latest notes');
  assert.equal(cleared, true);
});
