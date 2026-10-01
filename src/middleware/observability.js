import { randomUUID } from 'node:crypto';

export function requestContext({ now = () => Date.now() } = {}) {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
    req.startedAt = now();
    res.setHeader('x-request-id', req.id);
    next();
  };
}

export function accessLog({ stream = process.stdout, now = () => Date.now() } = {}) {
  return (req, res, next) => {
    res.on('finish', () => {
      const durationMs = now() - req.startedAt;
      const line = JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        bytes: res.getHeader('content-length') ?? 0,
        cache: res.getHeader('x-cache') ?? 'MISS'
      });
      stream.write(`${line}\n`);
    });
    next();
  };
}

export function metrics({ now = () => Date.now() } = {}) {
  const buckets = { under10: 0, under50: 0, under200: 0, under1000: 0, over: 0 };
  const state = {
    requests: 0,
    errors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    buckets,
    byStatus: {},
    byRoute: {}
  };
  const middleware = (req, res, next) => {
    res.on('finish', () => {
      const durationMs = now() - req.startedAt;
      state.requests += 1;
      state.totalDurationMs += durationMs;
      if (durationMs > state.maxDurationMs) state.maxDurationMs = durationMs;
      if (res.statusCode >= 500) state.errors += 1;
      if (durationMs < 10) buckets.under10 += 1;
      else if (durationMs < 50) buckets.under50 += 1;
      else if (durationMs < 200) buckets.under200 += 1;
      else if (durationMs < 1000) buckets.under1000 += 1;
      else buckets.over += 1;
      const statusKey = String(Math.floor(res.statusCode / 100));
      state.byStatus[statusKey] = (state.byStatus[statusKey] || 0) + 1;
      const route = res.getHeader('x-route') ?? 'unmatched';
      state.byRoute[route] = (state.byRoute[route] || 0) + 1;
    });
    next();
  };
  middleware.snapshot = () => ({
    requests: state.requests,
    errors: state.errors,
    avgDurationMs: state.requests === 0 ? 0 : Number((state.totalDurationMs / state.requests).toFixed(2)),
    maxDurationMs: state.maxDurationMs,
    latencyBuckets: { ...state.buckets },
    byStatus: { ...state.byStatus },
    byRoute: { ...state.byRoute },
    eventLoopLagMs: eventLoopLagMs()
  });
  return middleware;
}

export function eventLoopLagMs({ intervalMs = 20 } = {}) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setTimeout(() => {
      const delta = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(Number(Math.max(0, delta - intervalMs).toFixed(2)));
    }, intervalMs).unref?.();
  });
}
