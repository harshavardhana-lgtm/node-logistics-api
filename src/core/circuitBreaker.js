const CLOSED = 'closed';
const OPEN = 'open';
const HALF_OPEN = 'half-open';

export class CircuitBreaker {
  constructor({
    failureThreshold = 5,
    successThreshold = 2,
    openMs = 10000,
    now = () => Date.now()
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.openMs = openMs;
    this.now = now;
    this.state = CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.rejected = 0;
    this.transitions = 0;
  }

  get available() {
    return this.state === CLOSED ? true : this.state === HALF_OPEN ? true : false;
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      rejected: this.rejected,
      transitions: this.transitions
    };
  }

  canRequest(now = this.now()) {
    if (this.state === CLOSED) return true;
    if (this.state === OPEN) {
      if (now - this.openedAt >= this.openMs) {
        this.state = HALF_OPEN;
        this.successes = 0;
        this.transitions += 1;
        return true;
      }
      return false;
    }
    return true;
  }

  onSuccess() {
    if (this.state === HALF_OPEN) {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.transitions += 1;
      }
      return;
    }
    this.failures = 0;
  }

  onFailure() {
    if (this.state === HALF_OPEN) {
      this.state = OPEN;
      this.openedAt = this.now();
      this.successes = 0;
      this.transitions += 1;
      return;
    }
    if (this.state === OPEN) {
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = OPEN;
      this.openedAt = this.now();
      this.transitions += 1;
    }
  }

  async run(fn) {
    if (!this.canRequest()) {
      this.rejected += 1;
      const error = new Error('circuit breaker is open');
      error.code = 'E_CIRCUIT_OPEN';
      error.retryAfterMs = Math.max(0, this.openMs - (this.now() - this.openedAt));
      throw error;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}

export const BREAKER_STATES = { CLOSED, OPEN, HALF_OPEN };
