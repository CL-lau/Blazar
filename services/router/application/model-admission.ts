type Release = () => void;

type Waiter = {
  scope: string;
  admit: (release: Release) => void;
};

export class ModelAdmission {
  private total = 0;
  private readonly running = new Map<string, number>();
  private readonly waiting: Waiter[] = [];

  private available(scope: string) {
    return this.total < 16 && (this.running.get(scope) ?? 0) < 4;
  }

  private reserve(scope: string): Release {
    this.total++;
    this.running.set(scope, (this.running.get(scope) ?? 0) + 1);
    return () => {
      this.total--;
      const remaining = this.running.get(scope)! - 1;
      if (remaining) this.running.set(scope, remaining);
      else this.running.delete(scope);
      const next = this.waiting.findIndex(waiter => this.available(waiter.scope));
      if (next === -1) return;
      const [waiter] = this.waiting.splice(next, 1);
      waiter.admit(this.reserve(waiter.scope));
    };
  }

  acquire(scope: string, signal?: AbortSignal): Promise<Release | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (this.available(scope)) return Promise.resolve(this.reserve(scope));
    if (this.waiting.length >= 16 || this.waiting.filter(waiter => waiter.scope === scope).length >= 4) {
      return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
      const finish = (release?: Release) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(release);
      };
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        finish();
      };
      const waiter = {
        scope,
        admit: finish,
      };
      const timer = setTimeout(abort, 200);
      this.waiting.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
