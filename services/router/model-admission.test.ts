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
