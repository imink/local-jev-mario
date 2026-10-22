import { once } from 'node:events';

export function loopbackURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP numeric loopback URL (127.0.0.1 or [::1]) without credentials, query or fragment.',
    );
  return url.href.replace(/\/$/, '');
}

export function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}

export function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export async function body(request, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function checkLocalRequest(request) {
  const expected = `127.0.0.1:${request.socket.localPort}`;
  if (request.headers.host !== expected)
    throw new Error('Invalid Host. Open the numeric 127.0.0.1 address.');
  if (request.headers.origin && request.headers.origin !== `http://${expected}`)
    throw new Error('Cross-origin requests are not allowed.');
  if (
    request.headers['sec-fetch-site'] === 'cross-site' &&
    !(
      request.method === 'GET' &&
      request.headers['sec-fetch-mode'] === 'navigate'
    )
  )
    throw new Error('Cross-site requests are not allowed.');
}

export async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

export async function fetchJSON(url, options = {}) {
  loopbackURL(url);
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(125000),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(
      `Local service HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  return response.json();
}
