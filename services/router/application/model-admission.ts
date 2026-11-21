type Release = () => void;

type Waiter = {
  scope: string;
  admit: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
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
      clearTimeout(waiter.timer);
      waiter.admit(this.reserve(waiter.scope));
    };
  }

  acquire(scope: string): Promise<Release | undefined> {
    if (this.available(scope)) return Promise.resolve(this.reserve(scope));
    if (this.waiting.length >= 16 || this.waiting.filter(waiter => waiter.scope === scope).length >= 4) {
      return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
      const waiter = {
        scope,
        admit: resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          resolve(undefined);
        }, 200),
      };
      this.waiting.push(waiter);
    });
  }
}
