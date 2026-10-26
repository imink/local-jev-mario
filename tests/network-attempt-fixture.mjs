import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { mock } from 'node:test';

const scenario = process.argv[2];
assert.ok(['slow-first', 'all-stalled'].includes(scenario));
let submissions = 0;
const server = http.createServer(async (request, response) => {
  submissions++;
  assert.equal(request.method, 'POST');
  let body = '';
  for await (const chunk of request) body += chunk;
  assert.equal(body, 'one decision');
  response.setHeader('Connection', 'close');
  response.end('one answer');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const attempts = [];
mock.method(dns, 'lookup', (hostname, options, callback) => {
  assert.equal(hostname, 'connection-budget.test');
  assert.equal(options.all, true);
  callback(null, [
    { address: '127.0.0.2', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
});

// Only this child process simulates a pending TCP dial. Node's real address
// timers, fetch connector and successful loopback HTTP exchange remain intact.
const { TCP } = process.binding('tcp_wrap');
const connect = TCP.prototype.connect;
const started = performance.now();
mock.method(TCP.prototype, 'connect', function (request, address, port) {
  assert.ok(['127.0.0.1', '127.0.0.2'].includes(address));
  attempts.push({ address, elapsedMs: performance.now() - started });
  if (address === '127.0.0.2' || scenario === 'all-stalled') return 0;
  return connect.call(this, request, address, port);
});
let result;
try {
  const response = await fetch(
    `http://connection-budget.test:${server.address().port}/decision`,
    {
      method: 'POST',
      body: 'one decision',
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(15000),
    },
  );
  result = { status: response.status, body: await response.text() };
} catch (error) {
  result = { errorCode: error.cause?.code, errorName: error.name };
} finally {
  mock.restoreAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(
  JSON.stringify({
    ...result,
    allowance: getDefaultAutoSelectFamilyAttemptTimeout(),
    submissions,
    attempts,
    elapsedMs: performance.now() - started,
  }),
);
