import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelQueue } from './model-queue.ts';

test('interactive model work precedes waiting memory work and cancelled requests are skipped', async () => {
  const queue = new ModelQueue();
  const signal = new AbortController().signal;
  const cancelled = new AbortController();
  const held = Promise.withResolvers<void>();
  const order: string[] = [];

  const running = queue.run(1, signal, () => held.promise);
  const memory = queue.run(1, signal, async () => { order.push('memory'); });
  const removed = queue.run(0, cancelled.signal, async () => { order.push('cancelled'); });
  const chat = queue.run(0, signal, async () => { order.push('chat'); });
  const answer = queue.run(0, signal, async () => { order.push('answer'); });
  cancelled.abort();
  await assert.rejects(removed, { name: 'AbortError' });
  assert.deepEqual(order, []);

  held.resolve();
  await Promise.all([running, memory, chat, answer]);
  assert.deepEqual(order, ['chat', 'answer', 'memory']);
});
