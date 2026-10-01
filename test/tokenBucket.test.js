import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/core/tokenBucket.js';

function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('allows up to capacity then denies', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
  assert.equal(bucket.take('a').allowed, true);
  assert.equal(bucket.take('a').allowed, true);
  assert.equal(bucket.take('a').allowed, true);
  assert.equal(bucket.take('a').allowed, false);
});

test('a fresh bucket starts full', () => {
  const bucket = new TokenBucket({ capacity: 5 });
  assert.equal(bucket.peek('new'), 5);
});

test('denial reports remaining tokens and a retry hint', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
  bucket.take('a');
  bucket.take('a');
  const denied = bucket.take('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.retryAfterMs, 500);
});

test('tokens refill proportionally to elapsed time', () => {
  const clock = fakeClock(0);
  const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 10, now: clock.now });
  bucket.take('a');
  bucket.take('a');
  assert.equal(bucket.peek('a'), 8);
  clock.advance(200);
  assert.equal(bucket.peek('a'), 10, 'refills to capacity but not beyond');
});

test('a partial token is not enough to fund a whole request', () => {
  const clock = fakeClock(0);
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, now: clock.now });
  for (let i = 0; i < 5; i += 1) bucket.take('a');
  assert.equal(bucket.take('a').allowed, false);
  clock.advance(500);
  assert.equal(bucket.peek('a'), 0, 'half a token floors to zero whole tokens');
  assert.equal(bucket.take('a').allowed, false, 'half a token cannot fund a request');
  clock.advance(500);
  assert.equal(bucket.take('a').allowed, true, 'a full token refilled after one second');
});

test('time moving backwards does not add tokens', () => {
  const clock = fakeClock(10_000);
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 10, now: clock.now });
  bucket.take('a');
  clock.advance(-5000);
  assert.equal(bucket.peek('a') <= 4, true);
});

test('a cost above one token is charged in full', () => {
  const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
  assert.equal(bucket.take('a', 3).allowed, true);
  assert.equal(bucket.peek('a'), 2);
  assert.equal(bucket.take('a', 3).allowed, false);
});

test('keys are isolated from one another', () => {
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
  assert.equal(bucket.take('a').allowed, true);
  assert.equal(bucket.take('a').allowed, false);
  assert.equal(bucket.take('b').allowed, true, 'client b has its own bucket');
});

test('reset clears one key or all of them', () => {
  const bucket = new TokenBucket({ capacity: 1 });
  bucket.take('a');
  bucket.take('b');
  bucket.reset('a');
  assert.equal(bucket.size(), 1);
  assert.equal(bucket.peek('a'), 1);
  bucket.reset();
  assert.equal(bucket.size(), 0);
});

test('prune drops buckets idle beyond the threshold', () => {
  const clock = fakeClock(0);
  const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1, now: clock.now });
  bucket.take('old');
  clock.advance(1000);
  bucket.take('new');
  assert.equal(bucket.prune(500), 1);
  assert.equal(bucket.size(), 1);
});

test('zero refill rate denies with a zero retry hint', () => {
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0 });
  bucket.take('a');
  assert.equal(bucket.take('a').retryAfterMs, 0);
});

test('rejects invalid configuration', () => {
  assert.throws(() => new TokenBucket({ capacity: 0 }), RangeError);
  assert.throws(() => new TokenBucket({ refillPerSecond: -1 }), RangeError);
});
