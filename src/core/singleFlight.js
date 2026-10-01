export class SingleFlight {
  constructor() {
    this.inflight = new Map();
    this.coalesced = 0;
    this.failures = 0;
  }

  get pending() {
    return this.inflight.size;
  }

  async run(key, fn) {
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      this.coalesced += 1;
      return existing;
    }
    const promise = (async () => fn())().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  async runSettled(key, fn) {
    try {
      return { status: 'fulfilled', value: await this.run(key, fn) };
    } catch (error) {
      this.failures += 1;
      return { status: 'rejected', reason: error };
    }
  }

  stats() {
    return {
      inflight: this.inflight.size,
      coalesced: this.coalesced,
      failures: this.failures
    };
  }
}
