export class LruCache {
  constructor({ max = 1000, ttlMs = 0, now = () => Date.now() } = {}) {
    if (max < 1) throw new RangeError('max must be at least 1');
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.expirations = 0;
  }

  get size() {
    return this.map.size;
  }

  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  expired(entry) {
    return entry.expiresAt !== 0 && this.now() >= entry.expiresAt;
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.expired(entry)) {
      this.map.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, { value, expiresAt: ttlMs > 0 ? this.now() + ttlMs : 0 });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions += 1;
    }
    return this;
  }

  has(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.expired(entry)) {
      this.map.delete(key);
      this.expirations += 1;
      return false;
    }
    return true;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  prune() {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (this.expired(entry)) {
        this.map.delete(key);
        this.expirations += 1;
        removed += 1;
      }
    }
    return removed;
  }

  keys() {
    return [...this.map.keys()];
  }

  stats() {
    return {
      size: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number(this.hitRate.toFixed(4)),
      evictions: this.evictions,
      expirations: this.expirations
    };
  }
}
