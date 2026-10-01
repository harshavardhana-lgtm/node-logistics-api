import test from 'node:test';
import assert from 'node:assert/strict';
import { SingleFlight } from '../src/core/singleFlight.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('a single call runs the function once', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  const result = await flight.run('k', async () => {
    calls += 1;
    return 'value';
  });
  assert.equal(result, 'value');
  assert.equal(calls, 1);
});

test('concurrent calls for the same key are coalesced into one', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const all = Promise.all(
    Array.from({ length: 50 }, () =>
      flight.run('k', async () => {
        calls += 1;
        await gate;
        return calls;
      })
    )
  );
  release();
  const results = await all;
  assert.equal(calls, 1, 'upstream work must happen once');
  assert.equal(new Set(results).size, 1, 'all callers share one result');
  assert.equal(flight.stats().coalesced, 49);
});

test('different keys do not coalesce', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  await Promise.all([
    flight.run('a', async () => { calls += 1; return 'a'; }),
    flight.run('b', async () => { calls += 1; return 'b'; })
  ]);
  assert.equal(calls, 2);
});

test('inflight is cleared after completion so later calls rerun', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  await flight.run('k', async () => { calls += 1; });
  await flight.run('k', async () => { calls += 1; });
  assert.equal(calls, 2);
  assert.equal(flight.pending, 0);
});

test('a rejected call is not cached and clears inflight', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  await assert.rejects(
    flight.run('k', async () => {
      calls += 1;
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(flight.pending, 0);
  await flight.run('k', async () => {
    calls += 1;
    return 'recovered';
  });
  assert.equal(calls, 2, 'failure must not poison the key');
});

test('a rejected call rejects every coalesced caller', async () => {
  const flight = new SingleFlight();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const results = Array.from({ length: 5 }, () =>
    flight.runSettled('k', async () => {
      await gate;
      throw new Error('shared failure');
    })
  );
  release();
  const settled = await Promise.all(results);
  assert.equal(settled.every((row) => row.status === 'rejected'), true);
  assert.equal(flight.stats().failures, 5);
});

test('concurrent callers all observe the same rejection', async () => {
  const flight = new SingleFlight();
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, () =>
      flight.runSettled('k', async () => {
        await tick();
        throw new Error('nope');
      })
    )
  );
  assert.equal(outcomes.filter((row) => row.status === 'rejected').length, 10);
  assert.equal(flight.stats().inflight, 0);
});

test('runSettled resolves successful calls', async () => {
  const flight = new SingleFlight();
  const outcome = await flight.runSettled('k', async () => 42);
  assert.deepEqual(outcome, { status: 'fulfilled', value: 42 });
});
