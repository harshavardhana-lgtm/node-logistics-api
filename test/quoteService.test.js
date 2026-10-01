import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteService } from '../src/domain/quoteService.js';
import { PORTS } from '../src/domain/shipments.js';

const base = {
  originPort: 'SGSIN',
  destinationPort: 'NLRTM',
  cargoClass: 'container',
  weightKg: 1000
};

test('first call goes upstream, second is served from cache', async () => {
  let upstreamCalls = 0;
  const service = new QuoteService({
    ports: PORTS,
    latencyMs: 0,
    upstream: async () => {
      upstreamCalls += 1;
      return { priceUsd: 1000 };
    }
  });
  const first = await service.quote(base);
  const second = await service.quote(base);
  assert.equal(first.source, 'upstream');
  assert.equal(second.source, 'cache');
  assert.equal(upstreamCalls, 1);
  assert.equal(service.cache.stats().hits, 1);
});

test('concurrent identical calls hit upstream only once', async () => {
  let upstreamCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new QuoteService({
    ports: PORTS,
    latencyMs: 0,
    upstream: async () => {
      upstreamCalls += 1;
      await gate;
      return { priceUsd: 1000 };
    }
  });
  const calls = Array.from({ length: 40 }, () => service.quote(base));
  release();
  await Promise.all(calls);
  assert.equal(upstreamCalls, 1);
  assert.equal(service.flight.stats().coalesced, 39);
});

test('different cargo classes populate distinct cache entries', async () => {
  const service = new QuoteService({ ports: PORTS, latencyMs: 0 });
  await service.quote(base);
  await service.quote({ ...base, cargoClass: 'refrigerated' });
  assert.equal(service.cache.size, 2);
});

test('the breaker opens after repeated upstream failures', async () => {
  const service = new QuoteService({
    ports: PORTS,
    latencyMs: 0,
    failureThreshold: 3,
    openMs: 10000,
    upstream: async () => {
      throw new Error('upstream down');
    }
  });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(service.quote({ ...base, destinationPort: ['NLRTM', 'DEHAM', 'CNSHA'][i] }));
  }
  assert.equal(service.breaker.state, 'open');
  const error = await service.quote(base).catch((e) => e);
  assert.equal(error.status, 503);
});

test('an open breaker serves a cached quote without touching upstream', async () => {
  let upstreamCalls = 0;
  const service = new QuoteService({
    ports: PORTS,
    latencyMs: 0,
    failureThreshold: 1,
    upstream: async () => {
      upstreamCalls += 1;
      return { priceUsd: 42 };
    }
  });
  await service.quote(base);
  const cached = await service.quote(base);
  assert.equal(cached.source, 'cache');
  assert.equal(upstreamCalls, 1);
});

test('a failed call is counted and not cached', async () => {
  const service = new QuoteService({
    ports: PORTS,
    latencyMs: 0,
    failureThreshold: 100,
    upstream: async () => {
      throw new Error('transient');
    }
  });
  await assert.rejects(service.quote(base));
  assert.equal(service.cache.size, 0);
  assert.equal(service.counters.failed, 1);
});

test('invalidate clears cached quotes', async () => {
  const service = new QuoteService({ ports: PORTS, latencyMs: 0 });
  await service.quote(base);
  assert.equal(service.cache.size, 1);
  service.invalidate();
  assert.equal(service.cache.size, 0);
});

test('stats aggregate cache, flight and breaker state', async () => {
  const service = new QuoteService({ ports: PORTS, latencyMs: 0 });
  await service.quote(base);
  await service.quote(base);
  const stats = service.stats();
  assert.equal(stats.cache.size, 1);
  assert.equal(stats.breaker.state, 'closed');
  assert.equal(typeof stats.flight.coalesced, 'number');
});

test('an unknown port key surfaces as an upstream error', async () => {
  const service = new QuoteService({ ports: PORTS, latencyMs: 0, failureThreshold: 100 });
  const error = await service.quote({ originPort: 'ZZZZZ', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 1 }).catch((e) => e);
  assert.equal(error.code, 'E_BAD_KEY');
});
