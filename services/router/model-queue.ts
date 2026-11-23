// Adapted from Linger's ModelQueue admission and cancellation logic.
type Waiter = {
  priority: number;
  admit: () => void;
};

export class ModelQueue {
  private active = false;
  private readonly waiting: Waiter[] = [];

  async run<T>(priority: number, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        priority,
        admit: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      this.drain();
    });
    try {
      signal.throwIfAborted();
      return await execute();
    } finally {
      this.active = false;
      this.drain();
    }
  }

  private drain() {
    if (this.active || !this.waiting.length) return;
    // Stable sorting preserves arrival order within a priority.
    this.waiting.sort((left, right) => left.priority - right.priority);
    const next = this.waiting.shift()!;
    this.active = true;
    next.admit();
  }
}
