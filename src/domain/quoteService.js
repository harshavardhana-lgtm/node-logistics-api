import { LruCache } from '../core/lru.js';
import { SingleFlight } from '../core/singleFlight.js';
import { CircuitBreaker } from '../core/circuitBreaker.js';
import { PORTS } from './shipments.js';

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function greatCircleKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const CLASS_MULTIPLIER = {
  container: 1,
  refrigerated: 1.25,
  bulk: 0.9,
  breakbulk: 1.4,
  hazmat: 1.6,
  'vehicle-carrier': 1.8,
  'project-cargo': 2.2,
  livestock: 1.7
};

export class UpstreamTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamTimeoutError';
    this.code = 'E_UPSTREAM_TIMEOUT';
    this.status = 504;
  }
}

export class QuoteService {
  constructor({
    ports = PORTS,
    cacheMax = 2000,
    cacheTtlMs = 30000,
    cacheEnabled = true,
    failureThreshold = 5,
    openMs = 5000,
    latencyMs = 120,
    jitterMs = 60,
    upstream,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now()
  } = {}) {
    this.ports = ports;
    this.cacheEnabled = cacheEnabled;
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.sleep = sleep;
    this.now = now;
    this.cache = new LruCache({ max: cacheMax, ttlMs: cacheTtlMs, now });
    this.flight = new SingleFlight();
    this.breaker = new CircuitBreaker({ failureThreshold, openMs, now });
    this.upstream = upstream ?? (async (key) => this.simulateQuote(key));
    this.counters = { upstreamCalls: 0, served: 0, coalesced: 0, failed: 0 };
  }

  async simulateQuote(key) {
    const [originCode, destinationCode, cargoClass, weightKg] = key.split('|');
    const origin = this.ports.find((port) => port.code === originCode);
    const destination = this.ports.find((port) => port.code === destinationCode);
    if (origin === undefined || destination === undefined) {
      const error = new Error('unknown port in quote key');
      error.code = 'E_BAD_KEY';
      throw error;
    }
    const distanceKm = greatCircleKm(origin, destination);
    const multiplier = CLASS_MULTIPLIER[cargoClass] ?? 1;
    const base = 480 + distanceKm * 0.11 * multiplier;
    const weightSurcharge = Math.max(0, weightKg - 1000) * 0.012;
    return {
      originPort: origin.code,
      destinationPort: destination.code,
      cargoClass,
      distanceKm: Number(distanceKm.toFixed(1)),
      transitDays: Number((5 + (distanceKm / 800) * multiplier).toFixed(1)),
      priceUsd: Number((base + weightSurcharge).toFixed(2)),
      currency: 'USD',
      validUntil: new Date(this.now() + 30000).toISOString()
    };
  }

  static keyFor({ originPort, destinationPort, cargoClass, weightKg }) {
    return `${originPort}|${destinationPort}|${cargoClass}|${Math.round(weightKg / 500)}`;
  }

  async fetchUpstream(key) {
    this.counters.upstreamCalls += 1;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    if (this.latencyMs > 0) {
      await this.sleep(this.latencyMs + jitter);
    }
    return this.upstream(key);
  }

  async quote({ originPort, destinationPort, cargoClass, weightKg }) {
    const key = QuoteService.keyFor({ originPort, destinationPort, cargoClass, weightKg });
    if (this.cacheEnabled) {
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        this.counters.served += 1;
        return { source: 'cache', latencyMs: 0, cached, key };
      }
    }
    try {
      const quote = await this.flight.run(key, () =>
        this.breaker.run(async () => this.fetchUpstream(key))
      );
      if (this.cacheEnabled) this.cache.set(key, quote);
      this.counters.served += 1;
      if (this.flight.coalesced > 0) this.counters.coalesced = this.flight.coalesced;
      return { source: 'upstream', latencyMs: 0, cached: quote, key };
    } catch (error) {
      this.counters.failed += 1;
      if (error.code === 'E_CIRCUIT_OPEN') {
        error.status = 503;
        error.retryAfterMs = error.retryAfterMs ?? 1000;
      }
      throw error;
    }
  }

  withTimeout(promise, timeoutMs) {
    if (timeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new UpstreamTimeoutError(`upstream exceeded ${timeoutMs}ms`);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  invalidate() {
    this.cache.clear();
  }

  stats() {
    return {
      cache: this.cache.stats(),
      flight: this.flight.stats(),
      breaker: this.breaker.snapshot(),
      counters: { ...this.counters }
    };
  }
}
