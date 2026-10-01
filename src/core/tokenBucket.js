export class TokenBucket {
  constructor({ capacity = 100, refillPerSecond = 50, now = () => Date.now() } = {}) {
    if (capacity < 1) throw new RangeError('capacity must be at least 1');
    if (refillPerSecond < 0) throw new RangeError('refillPerSecond must not be negative');
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.buckets = new Map();
  }

  bucket(key, now = this.now()) {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
      bucket.updatedAt = now;
    }
    return bucket;
  }

  take(key, cost = 1, now = this.now()) {
    const bucket = this.bucket(key, now);
    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      const retryAfterMs = this.refillPerSecond > 0 ? Math.ceil((deficit / this.refillPerSecond) * 1000) : 0;
      return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
    }
    bucket.tokens -= cost;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  peek(key, now = this.now()) {
    const bucket = this.bucket(key, now);
    return Math.floor(bucket.tokens);
  }

  reset(key) {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }

  prune(idleMs, now = this.now()) {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size() {
    return this.buckets.size;
  }
}
