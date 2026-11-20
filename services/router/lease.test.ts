import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { maintainLease } from '../device/lease.ts';

test('device retries interrupted renewal and stops immediately on an explicit rejection', async () => {
  const stop = new AbortController();
  let attempts = 0;
  await maintainLease(performance.now() + 1000, async () => {
    attempts++;
    if (attempts === 1) throw new Error('Connection closed');
    if (attempts === 2) return 1000;
    return false;
  }, stop, stop.signal, 5, 5);
  assert.equal(attempts, 3);
  assert.equal(stop.signal.aborted, true);
});

test('device stops a renewal stalled past the last confirmed lease', async () => {
  const stop = new AbortController();
  let interrupted = false;
  await maintainLease(performance.now() + 100, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      interrupted = true;
      reject(signal.reason);
    }, { once: true });
  }), stop, stop.signal, 1, 1);
  assert.equal(interrupted, true);
  assert.equal(stop.signal.aborted, true);
});
