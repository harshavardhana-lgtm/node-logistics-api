import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BREAKER_STATES } from '../src/core/circuitBreaker.js';

function fakeClock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('starts closed and permits requests', () => {
  const breaker = new CircuitBreaker();
  assert.equal(breaker.state, BREAKER_STATES.CLOSED);
  assert.equal(breaker.canRequest(), true);
});

test('a success resets the failure count', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  await assert.rejects(breaker.run(async () => { throw new Error('x'); }));
  await assert.rejects(breaker.run(async () => { throw new Error('x'); }));
  assert.equal(breaker.failures, 2);
  await breaker.run(async () => 'ok');
  assert.equal(breaker.failures, 0);
});

test('opens once the failure threshold is reached', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(breaker.run(async () => { throw new Error('x'); }));
  }
  assert.equal(breaker.state, BREAKER_STATES.OPEN);
});

test('an open breaker rejects without invoking the function', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });
  await assert.rejects(breaker.run(async () => { throw new Error('x'); }));
  let invoked = false;
  const error = await breaker.run(async () => { invoked = true; }).catch((e) => e);
  assert.equal(invoked, false, 'upstream must not be called while open');
  assert.equal(error.code, 'E_CIRCUIT_OPEN');
  assert.equal(breaker.rejected, 1);
});

test('rejections while open carry a retry hint based on remaining cooldown', async () => {
  const clock = fakeClock(0);
  const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 5000, now: clock.now });
  await assert.rejects(breaker.run(async () => { throw new Error('x'); }));
  clock.advance(1000);
  const error = await breaker.run(async () => 1).catch((e) => e);
  assert.equal(error.code, 'E_CIRCUIT_OPEN');
  assert.equal(error.retryAfterMs, 4000);
});

test('transitions to half-open after the cooldown', () => {
  const clock = fakeClock(0);
  const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, now: clock.now });
  breaker.onFailure();
  breaker.onFailure();
  assert.equal(breaker.state, BREAKER_STATES.OPEN);
  clock.advance(999);
  assert.equal(breaker.canRequest(), false);
  clock.advance(1);
  assert.equal(breaker.canRequest(), true);
  assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);
});

test('closes after enough successes in half-open', () => {
  const clock = fakeClock(0);
  const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 2, openMs: 100, now: clock.now });
  breaker.onFailure();
  breaker.onFailure();
  clock.advance(100);
  breaker.canRequest();
  assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);
  breaker.onSuccess();
  assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);
  breaker.onSuccess();
  assert.equal(breaker.state, BREAKER_STATES.CLOSED);
  assert.equal(breaker.failures, 0);
});

test('reopens immediately on a failed half-open probe', () => {
  const clock = fakeClock(0);
  const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 100, now: clock.now });
  breaker.onFailure();
  breaker.onFailure();
  clock.advance(100);
  breaker.canRequest();
  assert.equal(breaker.state, BREAKER_STATES.HALF_OPEN);
  clock.advance(50);
  breaker.onFailure();
  assert.equal(breaker.state, BREAKER_STATES.OPEN);
});

test('run passes through a successful value', async () => {
  const breaker = new CircuitBreaker();
  assert.equal(await breaker.run(async () => 'payload'), 'payload');
});

test('transition counter records each state change', () => {
  const clock = fakeClock(0);
  const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, openMs: 10, now: clock.now });
  breaker.onFailure();
  breaker.onFailure();
  clock.advance(10);
  breaker.canRequest();
  breaker.onSuccess();
  assert.equal(breaker.state, BREAKER_STATES.CLOSED);
  assert.equal(breaker.transitions, 3);
});
