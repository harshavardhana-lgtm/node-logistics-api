export function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...headers
  });
  res.end(payload);
}

export function noContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

export function problem(res, status, code, message, details) {
  json(res, status, {
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  });
}

export async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request body too large');
      error.status = 413;
      error.code = 'E_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('request body is not valid JSON');
    error.status = 400;
    error.code = 'E_BAD_JSON';
    throw error;
  }
}
