import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyStore } from '../src/core/idempotency.js';

function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('a first request is not a replay and is stored', () => {
  const store = new IdempotencyStore();
  const outcome = store.begin('k', 'fp1');
  assert.equal(outcome.replay, false);
  assert.equal(store.size, 1);
});

test('a completed request replays its stored response', () => {
  const store = new IdempotencyStore();
  store.begin('k', 'fp1');
  store.complete('k', { id: 'SHP-1' });
  const replay = store.begin('k', 'fp1');
  assert.equal(replay.replay, true);
  assert.equal(replay.cached.status, 'completed');
  assert.deepEqual(replay.cached.response, { id: 'SHP-1' });
  assert.equal(store.stats().replays, 1);
});

test('reusing a key with a different payload is rejected', () => {
  const store = new IdempotencyStore();
  store.begin('k', 'fp1');
  const error = (() => {
    try {
      store.begin('k', 'fp2');
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.notEqual(error, null);
  assert.equal(error.code, 'E_IDEMPOTENCY_MISMATCH');
  assert.equal(error.status, 409);
});

test('an in-progress replay reports pending rather than completed', () => {
  const store = new IdempotencyStore();
  store.begin('k', 'fp1');
  const replay = store.begin('k', 'fp1');
  assert.equal(replay.replay, true);
  assert.equal(replay.cached.status, 'pending');
  assert.equal(replay.cached.response, undefined);
});

test('fail releases the key so a retry can proceed', () => {
  const store = new IdempotencyStore();
  store.begin('k', 'fp1');
  store.fail('k');
  assert.equal(store.size, 0);
  const retry = store.begin('k', 'fp1');
  assert.equal(retry.replay, false);
});

test('completed entries age out at the ttl', () => {
  const clock = fakeClock(0);
  const store = new IdempotencyStore({ ttlMs: 1000, now: clock.now });
  store.begin('k', 'fp1');
  store.complete('k', { id: 1 });
  clock.advance(999);
  assert.equal(store.begin('k', 'fp1').replay, true);
  clock.advance(1);
  const replay = store.begin('k', 'fp1');
  assert.equal(replay.replay, false, 'expired key is treated as new');
});

test('prune reclaims expired completed entries', () => {
  const clock = fakeClock(0);
  const store = new IdempotencyStore({ ttlMs: 100, now: clock.now });
  store.begin('a', 'x');
  store.complete('a', {});
  clock.advance(200);
  store.begin('b', 'y');
  assert.equal(store.prune(), 1);
  assert.equal(store.size, 1);
});

test('the entry limit evicts the oldest keys first', () => {
  const store = new IdempotencyStore({ maxEntries: 2 });
  store.begin('a', '1');
  store.begin('b', '2');
  store.begin('c', '3');
  assert.equal(store.size, 2);
  assert.equal(store.entry('a'), undefined);
  assert.equal(store.entry('c').fingerprint, '3');
});

test('a ttl of zero keeps entries indefinitely', () => {
  const clock = fakeClock(0);
  const store = new IdempotencyStore({ ttlMs: 0, now: clock.now });
  store.begin('k', 'fp');
  store.complete('k', { id: 1 });
  clock.advance(10_000_000);
  assert.equal(store.begin('k', 'fp').replay, true);
});
