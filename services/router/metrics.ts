import type { ModelTokens } from './harness.ts';

const bounds = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 15000];
type Timing = 'event' | 'feishu' | 'qq' | 'model';

export class RouterMetrics {
  private timings = new Map<Timing, { count: number; totalMs: number; buckets: number[] }>();
  private routes = { deterministic: 0, model: 0, replayed: 0, modelErrors: 0 };

  private tokens = { samples: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  recordModelUsage(usage: ModelTokens) {
    const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
    if ([input, output, cacheRead, cacheWrite, totalTokens].some(value => !Number.isSafeInteger(value) || value < 0)) return;
    this.tokens.samples++;
    this.tokens.input += input;
    this.tokens.output += output;
    this.tokens.cacheRead += cacheRead;
    this.tokens.cacheWrite += cacheWrite;
    this.tokens.totalTokens += totalTokens;
  }

  observe(name: Timing, durationMs: number) {
    let timing = this.timings.get(name);
    if (!timing) {
      timing = { count: 0, totalMs: 0, buckets: Array(bounds.length + 1).fill(0) };
      this.timings.set(name, timing);
    }
    const bin = bounds.findIndex(bound => durationMs <= bound);
    timing.buckets[bin < 0 ? bounds.length : bin]++;
    timing.count++;
    timing.totalMs += durationMs;
  }

  route(kind: keyof RouterMetrics['routes']) {
    this.routes[kind]++;
  }

  snapshot() {
    return {
      modelTokens: { ...this.tokens },
      routing: { ...this.routes },
      latencyMs: Object.fromEntries([...this.timings].map(([name, timing]) => {
        let cumulative = 0;
        const bucket = timing.buckets.findIndex(count => (cumulative += count) >= Math.ceil(timing.count * 0.95));
        return [name, {
          count: timing.count,
          mean: timing.totalMs / timing.count,
          p95UpperBound: bounds[bucket] ?? null,
        }];
      })),
    };
  }
}
