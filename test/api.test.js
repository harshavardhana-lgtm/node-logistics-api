import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function withServer(options, run) {
  const app = createApp({ quiet: true, shipmentCount: 120, quoteLatencyMs: 0, quoteJitterMs: 0, ...options });
  const port = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = async (method, path, { body, headers } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text.length === 0 ? undefined : JSON.parse(text)
    };
  };
  try {
    await run({ app, request, baseUrl });
  } finally {
    await app.close();
  }
}

test('health reports the loaded shipment count', async () => {
  await withServer({}, async ({ request }) => {
    const { status, body } = await request('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.shipments, 120);
  });
});

test('meta exposes ports, statuses and cargo classes', async () => {
  await withServer({}, async ({ request }) => {
    const { body } = await request('GET', '/meta');
    assert.equal(body.ports.length, 10);
    assert.equal(body.statuses.includes('IN_TRANSIT'), true);
    assert.equal(body.cargoClasses.includes('refrigerated'), true);
  });
});

test('listing paginates with total, limit and offset', async () => {
  await withServer({}, async ({ request }) => {
    const { body } = await request('GET', '/shipments?limit=10&offset=5');
    assert.equal(body.total, 120);
    assert.equal(body.limit, 10);
    assert.equal(body.offset, 5);
    assert.equal(body.data.length, 10);
  });
});

test('listing rejects nothing but clamps oversized limits', async () => {
  await withServer({}, async ({ request }) => {
    const { body } = await request('GET', '/shipments?limit=99999');
    assert.equal(body.limit, 500);
  });
});

test('listing filters by status', async () => {
  await withServer({}, async ({ request }) => {
    const { body } = await request('GET', '/shipments?status=DELIVERED');
    assert.equal(body.data.every((row) => row.status === 'DELIVERED'), true);
  });
});

test('fetching a single shipment returns an etag', async () => {
  await withServer({}, async ({ app, request }) => {
    const id = app.repo.all()[0].id;
    const { status, body, headers } = await request('GET', `/shipments/${id}`);
    assert.equal(status, 200);
    assert.equal(body.id, id);
    assert.equal(headers.get('etag'), '"v1"');
  });
});

test('fetching an unknown shipment returns a structured 404', async () => {
  await withServer({}, async ({ request }) => {
    const { status, body } = await request('GET', '/shipments/SHP-000000');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'E_NOT_FOUND');
  });
});

test('creating a shipment requires an idempotency key', async () => {
  await withServer({}, async ({ request }) => {
    const payload = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 500 };
    const { status, body } = await request('POST', '/shipments', { body: payload });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'E_IDEMPOTENCY_REQUIRED');
  });
});

test('creating a shipment with a key returns 201 and a location', async () => {
  await withServer({}, async ({ request }) => {
    const payload = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 500 };
    const { status, body, headers } = await request('POST', '/shipments', {
      body: payload,
      headers: { 'idempotency-key': 'key-1' }
    });
    assert.equal(status, 201);
    assert.equal(body.created.originPort, 'SGSIN');
    assert.equal(headers.get('location'), `/shipments/${body.created.id}`);
  });
});

test('replaying the same key and payload returns the original creation', async () => {
  await withServer({}, async ({ request }) => {
    const payload = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 500 };
    const first = await request('POST', '/shipments', { body: payload, headers: { 'idempotency-key': 'key-2' } });
    const second = await request('POST', '/shipments', { body: payload, headers: { 'idempotency-key': 'key-2' } });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    assert.equal(second.body.created.id, first.body.created.id);
  });
});

test('reusing a key with a different payload is rejected with 409', async () => {
  await withServer({}, async ({ request }) => {
    const first = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 500 };
    await request('POST', '/shipments', { body: first, headers: { 'idempotency-key': 'key-3' } });
    const second = await request('POST', '/shipments', {
      body: { ...first, pieces: 2 },
      headers: { 'idempotency-key': 'key-3' }
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'E_IDEMPOTENCY_MISMATCH');
  });
});

test('creating a shipment with invalid data returns 400', async () => {
  await withServer({}, async ({ request }) => {
    const { status, body } = await request('POST', '/shipments', {
      body: { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: -5 },
      headers: { 'idempotency-key': 'key-4' }
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'E_VALIDATION');
  });
});

test('patching updates fields and bumps the version', async () => {
  await withServer({}, async ({ app, request }) => {
    const id = app.repo.all()[0].id;
    const { status, body } = await request('PATCH', `/shipments/${id}`, { body: { status: 'DELIVERED' } });
    assert.equal(status, 200);
    assert.equal(body.status, 'DELIVERED');
    assert.equal(body.version, 2);
  });
});

test('patching rejects unknown fields', async () => {
  await withServer({}, async ({ app, request }) => {
    const id = app.repo.all()[0].id;
    const { status, body } = await request('PATCH', `/shipments/${id}`, { body: { bogus: true } });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'E_VALIDATION');
  });
});

test('patching rejects an unknown status', async () => {
  await withServer({}, async ({ app, request }) => {
    const id = app.repo.all()[0].id;
    const { status } = await request('PATCH', `/shipments/${id}`, { body: { status: 'TELEPORTED' } });
    assert.equal(status, 400);
  });
});

test('deleting removes the shipment and returns 204', async () => {
  await withServer({}, async ({ app, request }) => {
    const id = app.repo.all()[0].id;
    const removed = await request('DELETE', `/shipments/${id}`);
    assert.equal(removed.status, 204);
    assert.equal(removed.body, undefined);
    const after = await request('GET', `/shipments/${id}`);
    assert.equal(after.status, 404);
  });
});

test('deleting a missing shipment returns 404', async () => {
  await withServer({}, async ({ request }) => {
    const { status } = await request('DELETE', '/shipments/SHP-000000');
    assert.equal(status, 404);
  });
});

test('quotes are cached and report hit on the second request', async () => {
  await withServer({}, async ({ request }) => {
    const body = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 1000 };
    const first = await request('POST', '/quotes', { body });
    const second = await request('POST', '/quotes', { body });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal(first.body.priceUsd, second.body.priceUsd);
  });
});

test('the GET quote route validates ports', async () => {
  await withServer({}, async ({ request }) => {
    const bad = await request('GET', '/quotes/ZZZZZ/NLRTM');
    assert.equal(bad.status, 400);
    const good = await request('GET', '/quotes/SGSIN/NLRTM?cargoClass=bulk&weightKg=2000');
    assert.equal(good.status, 200);
    assert.equal(good.body.originPort, 'SGSIN');
  });
});

test('patching a shipment invalidates cached quotes', async () => {
  await withServer({}, async ({ app, request }) => {
    const quoteBody = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 1000 };
    await request('POST', '/quotes', { body: quoteBody });
    assert.equal(app.quotes.cache.size, 1);
    const id = app.repo.all()[0].id;
    await request('PATCH', `/shipments/${id}`, { body: { status: 'DELAYED' } });
    assert.equal(app.quotes.cache.size, 0);
  });
});

test('the circuit breaker opens and returns 503 without upstream calls', async () => {
  await withServer(
    {
      breakerFailureThreshold: 2,
      breakerOpenMs: 60000,
      upstream: async () => {
        throw new Error('upstream unavailable');
      }
    },
    async ({ request }) => {
      for (const destination of ['NLRTM', 'DEHAM']) {
        const body = { originPort: 'SGSIN', destinationPort: destination, cargoClass: 'container', pieces: 1, weightKg: 1000 };
        await request('POST', '/quotes', { body });
      }
      const { status, body } = await request('POST', '/quotes', {
        body: { originPort: 'SGSIN', destinationPort: 'CNSHA', cargoClass: 'container', pieces: 1, weightKg: 1000 }
      });
      assert.equal(status, 503);
      assert.equal(body.error.code, 'E_CIRCUIT_OPEN');
    }
  );
});

test('readiness fails while the breaker is open', async () => {
  await withServer(
    {
      breakerFailureThreshold: 1,
      breakerOpenMs: 60000,
      upstream: async () => {
        throw new Error('down');
      }
    },
    async ({ request }) => {
      await request('POST', '/quotes', {
        body: { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 1000 }
      });
      const { status, body } = await request('GET', '/health/ready');
      assert.equal(status, 503);
      assert.equal(body.error.code, 'E_NOT_READY');
    }
  );
});

test('rate limiting returns 429 after the bucket is drained', async () => {
  await withServer({ rateLimitCapacity: 3, rateLimitRefill: 0 }, async ({ request }) => {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push((await request('GET', '/health', { headers: { 'x-api-key': 'noisy' } })).status);
    }
    assert.deepEqual(results.slice(0, 3), [200, 200, 200]);
    assert.deepEqual(results.slice(3), [429, 429]);
  });
});

test('rate limit headers are present on allowed requests', async () => {
  await withServer({ rateLimitCapacity: 5 }, async ({ request }) => {
    const { headers } = await request('GET', '/health');
    assert.equal(headers.get('x-ratelimit-limit'), '5');
    assert.equal(headers.get('x-ratelimit-remaining'), '4');
  });
});

test('a request id is echoed and generated when absent', async () => {
  await withServer({}, async ({ request }) => {
    const provided = await request('GET', '/health', { headers: { 'x-request-id': 'trace-123' } });
    assert.equal(provided.headers.get('x-request-id'), 'trace-123');
    const generated = await request('GET', '/health');
    assert.equal(typeof generated.headers.get('x-request-id'), 'string');
    assert.equal(generated.headers.get('x-request-id').length > 10, true);
  });
});

test('unknown routes and methods produce structured errors', async () => {
  await withServer({}, async ({ request }) => {
    const missing = await request('GET', '/nope');
    assert.equal(missing.status, 404);
    const wrongMethod = await request('PUT', '/health');
    assert.equal(wrongMethod.status, 405);
  });
});

test('malformed JSON is rejected with 400', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-json' },
      body: '{not json'
    });
    assert.equal(response.status, 400);
  });
});

test('metrics collect request counts and latency buckets', async () => {
  await withServer({}, async ({ app, request }) => {
    await request('GET', '/health');
    await request('GET', '/meta');
    const stats = app.metrics.snapshot();
    assert.equal(stats.requests, 2);
    assert.equal(stats.errors, 0);
    assert.equal(typeof stats.avgDurationMs, 'number');
    assert.equal(stats.byStatus['2'] >= 2, true);
  });
});

test('admin stats expose cache, breaker and idempotency state', async () => {
  await withServer({}, async ({ request }) => {
    await request('GET', '/quotes/SGSIN/NLRTM');
    const { body } = await request('GET', '/admin/stats');
    assert.equal(body.quotes.breaker.state, 'closed');
    assert.equal(body.quotes.cache.size >= 1, true);
    assert.equal(body.shipments, 120);
    assert.equal(typeof body.idempotency.size, 'number');
  });
});

test('breaker reset returns the breaker to closed', async () => {
  await withServer(
    {
      breakerFailureThreshold: 1,
      breakerOpenMs: 60000,
      upstream: async () => {
        throw new Error('down');
      }
    },
    async ({ request }) => {
      await request('POST', '/quotes', {
        body: { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 1000 }
      });
      const opened = await request('GET', '/health/ready');
      assert.equal(opened.status, 503);
      const reset = await request('POST', '/admin/breaker/reset');
      assert.equal(reset.body.breaker.state, 'closed');
    }
  );
});

test('concurrent quote requests for one route call upstream once', async () => {
  let upstreamCalls = 0;
  await withServer(
    {
      upstream: async () => {
        upstreamCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { priceUsd: 999 };
      }
    },
    async ({ request }) => {
      const body = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 1000 };
      const answers = await Promise.all(Array.from({ length: 20 }, () => request('POST', '/quotes', { body })));
      assert.equal(answers.every((row) => row.status === 200), true);
      assert.equal(upstreamCalls, 1);
    }
  );
});
