import test from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/core/lru.js';

function fakeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    }
  };
}

test('stores and retrieves values', () => {
  const cache = new LruCache({ max: 3 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 1);
});

test('miss returns undefined and counts the miss', () => {
  const cache = new LruCache();
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 0);
});

test('evicts the least recently used entry at capacity', () => {
  const cache = new LruCache({ max: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a');
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
  assert.equal(cache.stats().evictions, 1);
});

test('overwriting a key does not grow the cache', () => {
  const cache = new LruCache({ max: 2 });
  cache.set('a', 1);
  cache.set('a', 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('a'), 2);
  assert.equal(cache.stats().evictions, 0);
});

test('entries expire exactly at the ttl boundary', () => {
  const clock = fakeClock(1000);
  const cache = new LruCache({ max: 4, ttlMs: 100, now: clock.now });
  cache.set('a', 1);
  clock.advance(99);
  assert.equal(cache.get('a'), 1);
  clock.advance(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.stats().expirations, 1);
});

test('ttl of zero means never expire', () => {
  const clock = fakeClock(0);
  const cache = new LruCache({ max: 4, ttlMs: 0, now: clock.now });
  cache.set('a', 1);
  clock.advance(10_000_000);
  assert.equal(cache.get('a'), 1);
});

test('per-entry ttl overrides the default', () => {
  const clock = fakeClock(0);
  const cache = new LruCache({ max: 4, ttlMs: 10, now: clock.now });
  cache.set('short', 1, 50);
  cache.set('tiny', 2, 5);
  clock.advance(10);
  assert.equal(cache.get('short'), 1);
  assert.equal(cache.get('tiny'), undefined);
});

test('has reports presence without affecting hit rate', () => {
  const cache = new LruCache();
  cache.set('a', 1);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.stats().hits, 0);
});

test('has returns false for an expired entry and reclaims it', () => {
  const clock = fakeClock(0);
  const cache = new LruCache({ max: 4, ttlMs: 10, now: clock.now });
  cache.set('a', 1);
  clock.advance(50);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.size, 0);
});

test('prune reclaims expired entries only', () => {
  const clock = fakeClock(0);
  const cache = new LruCache({ max: 8, ttlMs: 100, now: clock.now });
  cache.set('a', 1);
  cache.set('b', 2, 1000);
  clock.advance(200);
  assert.equal(cache.prune(), 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('b'), 2);
});

test('delete and clear remove entries', () => {
  const cache = new LruCache();
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('hit rate reflects traffic mix', () => {
  const cache = new LruCache();
  cache.set('a', 1);
  cache.get('a');
  cache.get('a');
  cache.get('a');
  cache.get('b');
  assert.equal(cache.hitRate, 0.75);
  assert.equal(cache.stats().hitRate, 0.75);
});

test('keys are ordered most-recently-used first', () => {
  const cache = new LruCache({ max: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a');
  assert.deepEqual(cache.keys(), ['b', 'c', 'a']);
});

test('rejects a max below one', () => {
  assert.throws(() => new LruCache({ max: 0 }), RangeError);
});
