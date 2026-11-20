import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export async function maintainLease(
  initialDeadline: number,
  renew: (signal: AbortSignal) => Promise<number | false>,
  stop: AbortController,
  signal: AbortSignal,
  interval = 10_000,
  retry = 1_000,
) {
  let deadline = initialDeadline;
  let next = interval;
  try {
    while (!signal.aborted) {
      const remaining = deadline - performance.now();
      if (remaining <= 1) break;
      await delay(Math.min(next, remaining), undefined, { signal });
      const budget = Math.floor(deadline - performance.now());
      if (budget <= 0) break;
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort();
        stop.abort();
      }, budget);
      const attempt = AbortSignal.any([signal, timeout.signal]);
      const started = performance.now();
      try {
        const extension = await renew(attempt);
        if (extension === false || attempt.aborted) break;
        deadline = started + extension;
        next = interval;
      } catch {
        next = retry;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    stop.abort();
  }
}
