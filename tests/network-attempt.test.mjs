import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { scripts } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const allowanceFlag = scripts.start
  .split(' ')
  .find((argument) =>
    argument.startsWith('--network-family-autoselection-attempt-timeout='),
  );
const fixture = fileURLToPath(
  new URL('./network-attempt-fixture.mjs', import.meta.url),
);
async function run(scenario) {
  assert.equal(
    allowanceFlag,
    '--network-family-autoselection-attempt-timeout=2000',
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [allowanceFlag, fixture, scenario],
    { timeout: 18000 },
  );
  return JSON.parse(stdout);
}

test('a stalled first address leaves time for the second with only one HTTP submission', async () => {
  const result = await run('slow-first');
  assert.equal(result.allowance, 2000);
  assert.equal(result.status, 200);
  assert.equal(result.body, 'one answer');
  assert.equal(result.submissions, 1);
  assert.deepEqual(
    result.attempts.map(({ address }) => address),
    ['127.0.0.2', '127.0.0.1'],
  );
  assert.ok(result.attempts[1].elapsedMs >= 1900);
  assert.ok(result.elapsedMs < 5000, JSON.stringify(result));
});

test('unreachable addresses retain the bounded fetch connect timeout without submitting HTTP', async () => {
  const result = await run('all-stalled');
  assert.equal(result.errorCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(result.submissions, 0);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts[1].elapsedMs < 5000);
  assert.ok(result.elapsedMs >= 9000 && result.elapsedMs < 14000);
});
