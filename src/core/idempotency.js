export class IdempotencyStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 10000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.replays = 0;
  }

  get size() {
    return this.entries.size;
  }

  entry(key) {
    const found = this.entries.get(key);
    if (found === undefined) return undefined;
    if (this.ttlMs > 0 && this.now() - found.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return found;
  }

  begin(key, fingerprint) {
    const found = this.entry(key);
    if (found === undefined) {
      this.entries.set(key, { fingerprint, status: 'pending', storedAt: this.now() });
      this.enforceLimit();
      return { replay: false, cached: undefined };
    }
    if (found.fingerprint !== fingerprint) {
      const error = new Error('idempotency key reused with a different payload');
      error.code = 'E_IDEMPOTENCY_MISMATCH';
      error.status = 409;
      throw error;
    }
    this.replays += 1;
    return { replay: true, cached: found };
  }

  complete(key, response) {
    const found = this.entry(key);
    if (found === undefined) return;
    found.status = 'completed';
    found.response = response;
    found.storedAt = this.now();
  }

  fail(key) {
    this.entries.delete(key);
  }

  enforceLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  prune() {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.ttlMs > 0 && this.now() - entry.storedAt >= this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats() {
    return { size: this.entries.size, replays: this.replays, maxEntries: this.maxEntries };
  }
}
