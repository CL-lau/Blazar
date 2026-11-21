import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelAdmission } from './application/model-admission.ts';

test('model admission queues a busy caller while a different caller can proceed', async () => {
  const admission = new ModelAdmission();
  const running = await Promise.all(Array.from({ length: 4 }, () => admission.acquire('first')));
  assert(running.every(Boolean));
  const queued = Array.from({ length: 4 }, () => admission.acquire('first'));
  assert.equal(await admission.acquire('first'), undefined);
  const independent = await admission.acquire('second');
  assert(independent);
  let nextStarted = false;
  const next = queued[0].then(release => {
    nextStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(nextStarted, false);
  running[0]!();
  const nextRelease = await next;
  assert(nextRelease);
  assert.equal(nextStarted, true);
  independent();
  for (const release of running.slice(1)) release!();
  nextRelease();
  for (const release of await Promise.all(queued.slice(1))) {
    assert(release);
    release();
  }
});

test('cancelling a queued model call frees its place immediately', async () => {
  const admission = new ModelAdmission();
  const running = await Promise.all(Array.from({ length: 4 }, () => admission.acquire('owner')));
  const controller = new AbortController();
  const cancelled = admission.acquire('owner', controller.signal);
  const waiting = Array.from({ length: 3 }, () => admission.acquire('owner'));

  assert.equal(await admission.acquire('owner'), undefined);
  controller.abort();
  assert.equal(await cancelled, undefined);
  const replacement = admission.acquire('owner');
  for (const release of running) release!();
  for (const release of await Promise.all([...waiting, replacement])) {
    assert(release);
    release();
  }
});
