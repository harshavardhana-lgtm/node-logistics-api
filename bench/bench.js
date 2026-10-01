import { createApp } from '../src/app.js';

const CONCURRENCY = 50;
const REQUESTS = 2000;
const PORTS = ['SGSIN', 'NLRTM', 'DEHAM', 'CNSHA', 'INNSA', 'AEJEA', 'USLAX', 'BRSSZ', 'ZADUR', 'KRPUS'];
const CARGO = ['container', 'refrigerated', 'bulk', 'hazmat', 'project-cargo'];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function buildRequests({ distinct }) {
  const requests = [];
  for (let n = 0; n < REQUESTS; n += 1) {
    const origin = PORTS[n % PORTS.length];
    let destination = PORTS[(n * 7 + 3) % PORTS.length];
    if (origin === destination) destination = PORTS[(n * 7 + 4) % PORTS.length];
    const weight = distinct ? 1000 + n * 13 : 1000 + (n % 12) * 250;
    requests.push({ origin, destination, cargo: CARGO[n % CARGO.length], weight });
  }
  return requests;
}

async function run(label, { cacheEnabled, distinct }) {
  const app = createApp({
    quiet: true,
    shipmentCount: 500,
    quoteLatencyMs: 40,
    quoteJitterMs: 0,
    cacheEnabled
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const requests = buildRequests({ distinct });
  const latencies = [];
  let cursor = 0;
  const start = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= requests.length) return;
        const { origin, destination, cargo, weight } = requests[index];
        const t0 = process.hrtime.bigint();
        const response = await fetch(
          `${base}/quotes/${origin}/${destination}?cargoClass=${cargo}&weightKg=${weight}`
        );
        await response.json();
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    })
  );
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  latencies.sort((a, b) => a - b);
  const stats = app.quotes.stats();
  const rps = REQUESTS / (wallMs / 1000);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  process.stdout.write(
    [
      `--- ${label} ---`,
      `requests        ${REQUESTS} at concurrency ${CONCURRENCY}`,
      `wall            ${wallMs.toFixed(0)} ms`,
      `throughput      ${rps.toFixed(0)} req/s`,
      `p50 / p95 / p99 ${p50.toFixed(1)} / ${p95.toFixed(1)} / ${p99.toFixed(1)} ms`,
      `upstream calls  ${stats.counters.upstreamCalls}`,
      `coalesced       ${stats.flight.coalesced}`,
      `cache hit rate  ${(stats.cache.hitRate * 100).toFixed(1)}%`,
      ''
    ].join('\n')
  );
  await app.close();
  return { rps, p50, p95, p99, upstream: stats.counters.upstreamCalls };
}

const uncached = await run('cache disabled, unique keys (worst case)', {
  cacheEnabled: false,
  distinct: true
});
const cached = await run('cache + single-flight, repeated keys (realistic)', {
  cacheEnabled: true,
  distinct: false
});

process.stdout.write(
  [
    'summary',
    `p50            ${uncached.p50.toFixed(1)} ms -> ${cached.p50.toFixed(1)} ms`,
    `p95            ${uncached.p95.toFixed(1)} ms -> ${cached.p95.toFixed(1)} ms`,
    `throughput     ${uncached.rps.toFixed(0)} -> ${cached.rps.toFixed(0)} req/s`,
    `upstream calls ${uncached.upstream} -> ${cached.upstream}`,
    ''
  ].join('\n')
);
