import { createServer as createHttpServer } from 'node:http';
import { Router } from './http/router.js';
import { json, noContent, problem, readJsonBody } from './http/respond.js';
import { requestContext, accessLog, metrics, eventLoopLagMs } from './middleware/observability.js';
import { rateLimit } from './middleware/rateLimit.js';
import { ShipmentRepository, parseShipmentInput, allowedPatchFields, CARGO_CLASSES, STATUSES, PORTS, EQUIPMENT } from './domain/shipments.js';
import { QuoteService } from './domain/quoteService.js';
import { IdempotencyStore } from './core/idempotency.js';

function fingerprint(body) {
  return JSON.stringify(body ?? null);
}

export function createApp(options = {}) {
  const {
    now = () => Date.now(),
    quiet = true,
    shipmentCount = 500,
    quoteLatencyMs = 120,
    quoteJitterMs = 60,
    rateLimitCapacity = 200,
    rateLimitRefill = 100,
    cacheTtlMs = 30000,
    cacheEnabled = true,
    breakerFailureThreshold = 5,
    breakerOpenMs = 5000,
    upstream,
    sleep
  } = options;

  const repo = new ShipmentRepository({ count: shipmentCount, now });
  const quotes = new QuoteService({
    ports: PORTS,
    latencyMs: quoteLatencyMs,
    jitterMs: quoteJitterMs,
    cacheTtlMs,
    cacheEnabled,
    failureThreshold: breakerFailureThreshold,
    openMs: breakerOpenMs,
    upstream,
    sleep,
    now
  });
  const idempotency = new IdempotencyStore({ now });
  const limiter = rateLimit({ capacity: rateLimitCapacity, refillPerSecond: rateLimitRefill, now });
  const metricsMw = metrics({ now });
  const router = new Router();

  router.get('/health', async (req, res) => {
    json(res, 200, { status: 'ok', uptimeSeconds: Number(process.uptime().toFixed(1)), shipments: repo.size });
  });

  router.get('/health/ready', async (req, res) => {
    const breakerOpen = quotes.breaker.state === 'open';
    if (breakerOpen) {
      problem(res, 503, 'E_NOT_READY', 'upstream circuit is open');
      return;
    }
    json(res, 200, { status: 'ready', cacheSize: quotes.cache.size });
  });

  router.get('/meta', async (req, res) => {
    json(res, 200, {
      cargoClasses: CARGO_CLASSES,
      statuses: STATUSES,
      equipment: EQUIPMENT,
      ports: PORTS.map(({ code, name, region, lon, lat }) => ({ code, name, region, lon, lat }))
    });
  });

  router.get('/shipments', async (req, res) => {
    const started = now();
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    const rows = repo.query({
      status: url.searchParams.get('status') ?? undefined,
      cargoClass: url.searchParams.get('cargoClass') ?? undefined,
      originPort: url.searchParams.get('originPort') ?? undefined,
      destinationPort: url.searchParams.get('destinationPort') ?? undefined,
      attentionOnly: url.searchParams.get('attentionOnly') === 'true',
      q: url.searchParams.get('q') ?? undefined
    });
    json(res, 200, {
      total: rows.length,
      limit,
      offset,
      count: Math.min(limit, Math.max(0, rows.length - offset)),
      data: rows.slice(offset, offset + limit)
    }, { 'x-cache': 'BYPASS', 'x-query-ms': String(now() - started) });
  });

  router.get('/shipments/:id', async (req, res) => {
    const found = repo.get(req.params.id);
    if (found === undefined) {
      problem(res, 404, 'E_NOT_FOUND', `no shipment with id ${req.params.id}`);
      return;
    }
    json(res, 200, found, { etag: `"v${found.version}"` });
  });

  router.get('/shipments/:id/events', async (req, res) => {
    const found = repo.get(req.params.id);
    if (found === undefined) {
      problem(res, 404, 'E_NOT_FOUND', `no shipment with id ${req.params.id}`);
      return;
    }
    json(res, 200, { id: found.id, version: found.version, status: found.status, updatedAt: found.updatedAt });
  });

  router.get('/facets', async (req, res) => {
    json(res, 200, repo.facets(), { 'x-cache': 'BYPASS' });
  });

  router.post('/shipments', async (req, res) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      problem(res, 400, 'E_IDEMPOTENCY_REQUIRED', 'POST /shipments requires an Idempotency-Key header');
      return;
    }
    const body = await readJsonBody(req);
    const input = parseShipmentInput(body);
    const outcome = idempotency.begin(key, fingerprint(input));
    if (outcome.replay && outcome.cached.status === 'completed') {
      json(res, 200, outcome.cached.response, { 'idempotent-replay': 'true' });
      return;
    }
    try {
      const created = repo.insert(repo.generate(input));
      const response = { created };
      idempotency.complete(key, response);
      json(res, 201, response, { location: `/shipments/${created.id}` });
    } catch (error) {
      idempotency.fail(key);
      throw error;
    }
  });

  router.patch('/shipments/:id', async (req, res) => {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== 'object') {
      problem(res, 400, 'E_VALIDATION', 'request body must be a JSON object');
      return;
    }
    const allowed = new Set(allowedPatchFields());
    const unknown = Object.keys(body).filter((field) => !allowed.has(field));
    if (unknown.length > 0) {
      problem(res, 400, 'E_VALIDATION', `unknown fields: ${unknown.join(', ')}`, { unknown });
      return;
    }
    if (body.status !== undefined && !STATUSES.includes(body.status)) {
      problem(res, 400, 'E_VALIDATION', `unknown status: ${body.status}`, { field: 'status' });
      return;
    }
    if (body.destinationPort !== undefined && !PORTS.some((port) => port.code === body.destinationPort)) {
      problem(res, 400, 'E_VALIDATION', `unknown destinationPort: ${body.destinationPort}`, { field: 'destinationPort' });
      return;
    }
    const updated = repo.update(req.params.id, body);
    if (updated === undefined) {
      problem(res, 404, 'E_NOT_FOUND', `no shipment with id ${req.params.id}`);
      return;
    }
    quotes.invalidate();
    json(res, 200, updated, { etag: `"v${updated.version}"` });
  });

  router.delete('/shipments/:id', async (req, res) => {
    const removed = repo.remove(req.params.id);
    if (!removed) {
      problem(res, 404, 'E_NOT_FOUND', `no shipment with id ${req.params.id}`);
      return;
    }
    noContent(res);
  });

  router.post('/quotes', async (req, res) => {
    const body = await readJsonBody(req);
    const started = now();
    const input = parseShipmentInput(body);
    const result = await quotes.quote(input);
    json(res, 200, {
      ...result.cached,
      meta: {
        source: result.source,
        durationMs: now() - started,
        cacheHit: result.source === 'cache',
        breaker: quotes.breaker.state,
        coalesced: quotes.flight.coalesced
      }
    }, {
      'x-cache': result.source === 'cache' ? 'HIT' : 'MISS',
      'x-upstream-source': result.source
    });
  });

  router.get('/quotes/:origin/:destination', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const started = now();
    const input = {
      originPort: req.params.origin,
      destinationPort: req.params.destination,
      cargoClass: url.searchParams.get('cargoClass') ?? 'container',
      weightKg: Number(url.searchParams.get('weightKg') ?? 1000)
    };
    if (!PORTS.some((port) => port.code === input.originPort)) {
      problem(res, 400, 'E_VALIDATION', `unknown originPort: ${input.originPort}`, { field: 'originPort' });
      return;
    }
    if (!PORTS.some((port) => port.code === input.destinationPort)) {
      problem(res, 400, 'E_VALIDATION', `unknown destinationPort: ${input.destinationPort}`, { field: 'destinationPort' });
      return;
    }
    const result = await quotes.quote(input);
    json(res, 200, {
      ...result.cached,
      meta: {
        source: result.source,
        durationMs: now() - started,
        cacheHit: result.source === 'cache'
      }
    }, { 'x-cache': result.source === 'cache' ? 'HIT' : 'MISS' });
  });

  router.post('/admin/cache/invalidate', async (req, res) => {
    quotes.invalidate();
    json(res, 200, { invalidated: true, cacheSize: quotes.cache.size });
  });

  router.post('/admin/breaker/reset', async (req, res) => {
    const breaker = quotes.breaker;
    breaker.state = 'closed';
    breaker.failures = 0;
    breaker.successes = 0;
    json(res, 200, { breaker: breaker.snapshot() });
  });

  router.get('/admin/stats', async (req, res) => {
    json(res, 200, {
      shipments: repo.size,
      idempotency: idempotency.stats(),
      rateLimitClients: limiter.bucket.size(),
      quotes: quotes.stats(),
      eventLoopLagMs: await eventLoopLagMs()
    });
  });

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.path = url.pathname;
    res.setHeader('x-route', 'pending');
    Promise.resolve()
      .then(() => router.match(req.method, req.path))
      .then((matched) => {
        if (matched === null) {
          problem(res, 404, 'E_NOT_FOUND', `no route for ${req.method} ${req.pathname}`);
          return;
        }
        if (matched.methodMismatch) {
          res.setHeader('allow', 'GET,POST,PUT,PATCH,DELETE');
          problem(res, 405, 'E_METHOD_NOT_ALLOWED', `${req.method} not allowed on ${req.pathname}`);
          return;
        }
        req.params = matched.params;
        res.setHeader('x-route', `${req.method} ${matched.route.pattern}`);
        return matched.route.handler(req, res);
      })
      .catch((error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = error.status ?? 500;
        const code = error.code ?? 'E_INTERNAL';
        if (status >= 500) process.stderr.write(`${JSON.stringify({ level: 'error', requestId: req.id, message: error.message, stack: error.stack })}\n`);
        const headers = {};
        if (error.retryAfterMs !== undefined) {
          headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000));
        }
        problem(res, status, code, error.message, error.details);
      });
  };

  const stack = [requestContext({ now }), metricsMw];
  if (!quiet) stack.push(accessLog({ now }));
  stack.push(limiter);

  const server = createHttpServer((req, res) => {
    let index = 0;
    const fail = (error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status ?? 500;
      if (status >= 500) {
        process.stderr.write(`${JSON.stringify({ level: 'error', requestId: req.id, message: error.message, stack: error.stack })}\n`);
      }
      const headers = {};
      if (error.retryAfterMs !== undefined) {
        headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000));
      }
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      problem(res, status, error.code ?? 'E_INTERNAL', error.message, error.details);
    };
    const run = (error) => {
      if (error) {
        fail(error);
        return;
      }
      const layer = stack[index];
      index += 1;
      if (layer === undefined) {
        handler(req, res);
        return;
      }
      try {
        layer(req, res, run);
      } catch (caught) {
        fail(caught);
      }
    };
    run();
  });

  return {
    server,
    repo,
    quotes,
    idempotency,
    limiter,
    metrics: metricsMw,
    router,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
