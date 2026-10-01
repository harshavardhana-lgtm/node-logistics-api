import { TokenBucket } from '../core/tokenBucket.js';

export function clientKey(req) {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return `key:${header}`;
  return `ip:${req.socket?.remoteAddress ?? 'unknown'}`;
}

export function rateLimit({ capacity = 200, refillPerSecond = 100, keyFn = clientKey, now = () => Date.now() } = {}) {
  const bucket = new TokenBucket({ capacity, refillPerSecond, now });
  const middleware = (req, res, next) => {
    const key = keyFn(req);
    const result = bucket.take(key);
    res.setHeader('x-ratelimit-limit', String(capacity));
    res.setHeader('x-ratelimit-remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      res.setHeader('x-ratelimit-reset-ms', String(result.retryAfterMs));
      const error = new Error('rate limit exceeded');
      error.status = 429;
      error.code = 'E_RATE_LIMITED';
      error.retryAfterMs = result.retryAfterMs;
      next(error);
      return;
    }
    next();
  };
  middleware.bucket = bucket;
  return middleware;
}
