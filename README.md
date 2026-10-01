# logistics-api

A shipment and freight-quoting REST API in Node.js with **zero runtime
dependencies** — no Express, no framework, no npm install. The router, middleware
pipeline, cache, rate limiter, circuit breaker and idempotency store are all built
on `node:http` and the standard library.

The point of the project is the API-performance and resilience layer, not the CRUD:
caching, request coalescing, back-pressure, bulkheads, and graceful draining.

```
1,414 lines of source, 1,331 lines of tests, 115 tests, 0 dependencies
```

## Quick start

```bash
node src/server.js          # or: npm start
curl localhost:8080/health
curl "localhost:8080/shipments?limit=2&status=IN_TRANSIT"
curl "localhost:8080/quotes/SGSIN/NLRTM?cargoClass=container&weightKg=5000"
```

```bash
npm test              # 115 tests
npm run test:shutdown # spawns a real server, proves SIGTERM draining
npm run bench         # cache on vs off
```

Requires Node 20+ (developed on 22). `npm install` is not needed and there is
nothing to install.

## What it does

15 routes over a deterministic in-memory shipment repository (500 seeded rows,
identical every boot) and a simulated upstream rate engine.

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/health` | liveness |
| GET | `/health/ready` | 503 while the upstream circuit is open |
| GET | `/meta` | ports, statuses, cargo classes, equipment types |
| GET | `/shipments` | filter by status/cargo/ports, free-text `q`, `attentionOnly`, paginated |
| GET | `/shipments/:id` | ETag per version |
| GET | `/shipments/:id/events` | current version, for cheap client polling |
| GET | `/facets` | counts per status/cargo/origin/destination |
| POST | `/shipments` | requires `Idempotency-Key` |
| PATCH | `/shipments/:id` | whitelisted fields only, bumps version, invalidates quote cache |
| DELETE | `/shipments/:id` | 204 |
| POST | `/quotes` | cached, coalesced, breaker-protected |
| GET | `/quotes/:origin/:destination` | same, with query params |
| POST | `/admin/cache/invalidate` | |
| POST | `/admin/breaker/reset` | |
| GET | `/admin/stats` | cache/flight/breaker/idempotency/event-loop-lag |

Errors are uniform: `{"error":{"code":"E_...","message":"..."}}` with a matching
HTTP status and a `x-request-id` that is echoed in the structured log line.

## The four primitives

Each is a standalone, dependency-free module with its own test file, and each is
reused rather than reimplemented.

**`LruCache`** — O(1) LRU with per-entry TTL, injectable clock, and hit/miss/
eviction/expiration counters. Insertion order does the work: `Map` preserves it,
`get` deletes and re-sets the key to move it to most-recent, and eviction pops
from the front. Expiry is checked lazily on read, with a `prune()` for sweeping.

**`SingleFlight`** — collapses concurrent requests for the same key into one
upstream call. A test fires 50 simultaneous callers and asserts the underlying
work ran exactly once. Failures are not cached: the key is removed in `finally`,
so a transient upstream error does not poison the key, and a probe after a
failure succeeds.

**`TokenBucket`** — per-client rate limiting. Buckets refill continuously rather
than resetting on a fixed window, so a client cannot burn a quota and then send
double immediately after the boundary. Note the floor: at 0.5 tokens the bucket
reports `0`, and a request costs a whole token, so fractional accumulation is
correct but not sufficient for a request.

**`CircuitBreaker`** — closed → open → half-open. After `failureThreshold`
consecutive failures it opens and rejects without calling upstream. After the
cooldown it admits a single half-open probe; `successThreshold` successes close
it, one failure reopens it. Rejections carry `retry-after`. An `onFailure` while
already open is a no-op, so the cooldown is not extended by traffic that was
rejected rather than attempted.

## Results

`npm run bench`, 2,000 requests at concurrency 50 against a 40 ms simulated
upstream:

| | cache off (unique keys) | cache on (repeated keys) |
| - | - | - |
| upstream calls | 184 | 60 |
| p50 | 26.5 ms | 21.1 ms |
| p95 | 82.8 ms | 35.0 ms |
| p99 | 132.1 ms | 90.1 ms |
| throughput | 1,403 req/s | 2,044 req/s |

The two columns are not the same workload, and the benchmark makes that explicit
rather than pretending otherwise: with the cache off every key is unique, so it is
a genuine worst case and nothing can be reused. Turning the cache on with
*unique* keys would only add overhead — that is a fair way to make a cache look
bad. The realistic case is repeated keys, which is what clients actually produce,
and that is the right-hand column. The 3x drop in upstream calls is the cache
doing its job; the p95 gain is smaller than the hit rate suggests because the
remaining misses are the slow tail.

Single-flight matters most exactly where the cache misses — a cold key under a
thundering herd. The API test fires 20 concurrent requests for one route and
asserts one upstream call.

## Bugs found while building this

Not hypotheticals. All four were caught by tests or by measuring.

**The middleware chain swallowed every error.** Layers received `next` and
`next(error)` was silently discarded, because the continuation was an arrow
function that took no parameters and only ever read the next layer. Only
*synchronous throws* were caught, by a `try/catch` that sat above the layer. The
rate limiter called `next(error)` on every 429 — and every 429 came back `200` with
`x-ratelimit-remaining: 0`. 30 tests failed at once, all downstream of one
missing `if (error) return fail(error)` at the top of the chain.

**Every route returned 404.** The handler computed `req.path` and then matched
against `req.pathname`, which is `undefined`. The tests that passed were the ones
asserting 404 and 405 — which is a fair warning that a suite can be green for the
wrong reason.

**The benchmark measured nothing.** It compared "cache with TTL 30s" against
"cache with TTL 0" — and TTL 0 means *never expire*, so both runs had a live
cache and both showed ~85% hit rate and identical upstream counts. The `null`
result (0 calls avoided) is what exposed it. `LruCache` treats `ttlMs: 0` as
"no expiry" and `QuoteService` now takes an explicit `cacheEnabled` flag, because
"no cache" and "cache forever" are different requirements and one flag cannot
express both. The request set also had only ~50 distinct keys, so the workload
could not show a difference.

**Graceful shutdown hung with keep-alive connections open.** The drain watchdog
was `unref()`'d, so when the event loop had nothing left to do the timer was
skipped instead of firing, and `server.close()` does not reap idle keep-alive
sockets on its own — the process sat there indefinitely. `npm run
test:shutdown` now proves it: 40 idle keep-alive sockets, SIGTERM, exit in 13 ms.

The same harness also verifies the drain itself — SIGTERM arrives while a quote
is in flight, the request still completes with 200, the log prints
`all in-flight requests drained`, and the process exits 0 after 180 ms. Shutdown
that drops in-flight work is not graceful shutdown.

## Idempotency

`POST /shipments` requires an `Idempotency-Key`. The key is fingerprinted against
the request body, so a retry after a network timeout returns the original record
instead of creating a duplicate, while reusing a key with a *different* payload
is a 409 rather than a silent surprise. A failed attempt releases the key so the
client can retry. Entries expire on a TTL and the store is capped by entry count.

```
POST /shipments  Idempotency-Key: demo-1   -> 201 { created: { id: SHP-100501 } }
POST /shipments  Idempotency-Key: demo-1   -> 200 { created: { id: SHP-100501 } }  (replay)
POST /shipments  Idempotency-Key: demo-1   -> 409 (different body)
```

## Design notes

**Everything time-dependent takes an injected clock.** The token bucket, LRU,
idempotency store and breaker all accept `now`, so expiry is tested by advancing
a fake clock rather than by sleeping. The suite runs in about two seconds and has
no flakiness from timing.

**Shipment generation is seeded and reproducible.** The same seed and clock
produce byte-identical rows, which is what makes the domain tests assertable at
all. The earlier `07` simulator had the same class of bug — an internal
`Date.now()` that made "deterministic" untestable.

**The cache is keyed on weight rounded to 500 kg.** Exact weights would make the
hit rate near zero on real traffic, where consecutive requests differ by a few
kilograms. The cost is a small, bounded error in the quoted price; the tradeoff is
stated rather than hidden.

**`PATCH` invalidates the whole quote cache.** Over-invalidation. A real
deployment would invalidate only quotes whose inputs intersect the changed
shipment. Invalidating everything is correct and simple, and it is a visible
conservative choice, not an oversight.

## Scope

In-memory state, seeded and resettable — no database, no migrations, no
persistence across restarts. The repository and the rate engine are in-process
simulations, and the "upstream" is a fixed-latency function, not a network peer.
The rate limiter keys on `x-api-key` when present and falls back to the socket
address, which is not meaningful behind a proxy. There is no authentication or
authorisation, and the `/admin` routes are unauthenticated by design in a
project like this — they would be the first thing to gate in anything real.
