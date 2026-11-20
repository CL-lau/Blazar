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
