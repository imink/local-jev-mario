import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Game } from '../game.mjs';
import {
  DEFAULT_JEV_MODEL,
  OFFICIAL_JEV_URL,
  decisionConfig,
  officialRequest,
} from '../official-jev.mjs';
import { ACTIONS, checkJev, choose, parseDecision } from '../policy.mjs';
import { Telemetry } from '../telemetry.mjs';
import { ramFixture } from './fixtures.mjs';

const apiKey = 'test-only-not-a-real-key';
const config = {
  backend: 'jev-official',
  baseURL: OFFICIAL_JEV_URL,
  model: DEFAULT_JEV_MODEL,
  apiKey,
};
const state = () => new Telemetry(16).sample(ramFixture(), 0);
function answer(action = 'left') {
  return {
    model: DEFAULT_JEV_MODEL,
    answers: {
      move: {
        type: 'choice',
        choice: action,
        probabilities: Object.fromEntries(
          Object.keys(ACTIONS).map((key) => [
            key,
            key === action ? 0.8 : 0.025,
          ]),
        ),
        confidence: 0.775,
      },
      jump_needed: { type: 'noul', noul: 0.3 },
    },
    usage: { input_tokens: 123, output_tokens: 0 },
  };
}
const response = (value) => new Response(JSON.stringify(value));

test('official configuration is opt-in and reads only the requested credential field', (t) => {
  assert.equal(decisionConfig({}).backend, 'this-that');
  assert.throws(() => decisionConfig({ DECISION_BACKEND: 'typo' }));
  assert.throws(() => decisionConfig({ DECISION_BACKEND: 'jev-official' }));
  assert.throws(() =>
    decisionConfig({
      DECISION_BACKEND: 'jev-official',
      TYPESAFE_API_KEY: apiKey,
      JEV_MODEL: 'gemma',
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), 'mario-official-config-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, '.env');
  writeFileSync(
    file,
    `TYPESAFE_API_KEY="${apiKey}"\nGAME_PORT=9999\nJEV_MODEL=jev-latest\n`,
  );
  const configured = decisionConfig({
    DECISION_BACKEND: 'jev-official',
    TYPESAFE_API_KEY: 'ignored-environment-key',
    TYPESAFE_ENV_FILE: file,
  });
  assert.deepEqual(configured, config);
  writeFileSync(file, 'UNRELATED_KEY=not-the-requested-secret');
  assert.throws(() =>
    decisionConfig({
      DECISION_BACKEND: 'jev-official',
      TYPESAFE_API_KEY: apiKey,
      TYPESAFE_ENV_FILE: file,
    }),
  );
  assert.throws(() =>
    decisionConfig({
      DECISION_BACKEND: 'jev-official',
      TYPESAFE_ENV_FILE: join(directory, 'missing.env'),
    }),
  );
});

test('official wire format preserves nine choices, native confidence, and a negative choice', async (t) => {
  let calls = 0;
  const snapshot = state();
  snapshot.navigation.runJumpTargetX = 160;
  snapshot.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [16, 192, 'grounded'],
          held: [32, 192, 'grounded'],
          jumpReadyNext: true,
          survivesWithOneReplan: true,
          runJumpLanding: action === 'right_run_jump',
        },
      ]),
    ),
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `${OFFICIAL_JEV_URL}/v1/systemone`);
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Connection, 'close');
    assert.equal(options.headers['x-link-run-id'], undefined);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!options.body.includes(apiKey));
    const body = JSON.parse(options.body);
    assert.equal(body.model, DEFAULT_JEV_MODEL);
    assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
    assert.deepEqual(
      Object.keys(body.questions.move.criteria),
      Object.keys(ACTIONS),
    );
    assert.equal(
      body.state.outcomes.left.result,
      'DOES NOT MEET the required condition',
    );
    assert.deepEqual(body.state.game.memory, []);
    return response(answer());
  });
  const decision = await choose(snapshot, { ...config, runId: 'private-run' });
  assert.equal(calls, 1);
  assert.equal(decision.action, 'left');
  assert.equal(decision.raw.answers.move.choice, decision.action);
  assert.equal(decision.backend, 'jev-official');
  assert.equal(decision.confidence, 0.775);
  assert.equal(decision.probabilities.left, 0.8);
  assert.equal(decision.inputStats.inputTokens, 123);
  assert.ok(!JSON.stringify(decision).includes(apiKey));
  assert.throws(() => parseDecision(answer()), /probability distribution/);
});

test('official requests reject endpoint changes, redirects, and HTTP failures without retries', async (t) => {
  let calls = 0;
  let status = 401;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return new Response(apiKey, {
      status,
      headers: status === 302 ? { Location: 'https://example.com' } : {},
    });
  });
  await assert.rejects(
    choose(state(), { ...config, baseURL: 'https://example.com' }),
    /only uses/,
  );
  await assert.rejects(
    officialRequest('https://example.com', { apiKey }),
    /Unsupported/,
  );
  assert.equal(calls, 0);
  for (status of [401, 422, 429, 500, 302]) {
    await assert.rejects(choose(state(), config), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
  assert.equal(calls, 5);
});

test('official transport and malformed responses fail without leaking credentials', async (t) => {
  let result = answer();
  t.mock.method(globalThis, 'fetch', async () => {
    if (result instanceof Error) throw result;
    return result instanceof Response ? result : response(result);
  });
  for (const invalid of [
    { ...answer(), model: 'flock-io/this-that-model-1.2' },
    { ...answer(), model: 'jev-1.13.0' },
    { ...answer(), answers: {} },
  ]) {
    result = invalid;
    await assert.rejects(choose(state(), config));
  }
  result = answer();
  result.answers.move.probabilities = undefined;
  await assert.rejects(choose(state(), config));
  result = answer();
  result.answers.move.confidence = null;
  await assert.rejects(choose(state(), config));
  result = new Response('not JSON');
  await assert.rejects(choose(state(), config), /invalid JSON/);
  result = new Error(`transport accidentally included ${apiKey}`);
  await assert.rejects(choose(state(), config), (error) => {
    assert.ok(!error.message.includes(apiKey));
    assert.match(error.message, /network request failed/);
    return true;
  });
  for (const [cause, expected] of [
    [{ code: 'ECONNRESET' }, 'ECONNRESET'],
    [{ code: apiKey }, 'transport'],
  ]) {
    result = new Error(apiKey, { cause });
    await assert.rejects(choose(state(), config), (error) => {
      assert.ok(!error.message.includes(apiKey));
      assert.ok(error.message.includes(`(${expected})`));
      return true;
    });
  }
  result = new DOMException(apiKey, 'TimeoutError');
  await assert.rejects(choose(state(), config), /failed \(timeout\)/);
  await assert.rejects(
    choose(state(), { ...config, signal: AbortSignal.abort() }),
    /aborted/,
  );
});

const errorDetails = (error) =>
  JSON.parse(error.message.split('agent stopped. ')[1]);

test('HTTP error fixtures retain only bounded redacted provider fields without retrying', async (t) => {
  let calls = 0;
  const bodies = [
    JSON.stringify({
      error: {
        type: 'provider_policy',
        code: 'restricted',
        message: `Access is restricted by provider policy.\nAuthorization: Bearer header-secret\nTYPESAFE_API_KEY=field-secret\nCredential ${apiKey}`,
        headers: { cookie: 'ignored-cookie' },
      },
      request: { key: apiKey },
    }),
    JSON.stringify({
      code: 451,
      detail: `Denied for ${encodeURIComponent(apiKey)}`,
    }),
    JSON.stringify({
      error: `Credential ${Buffer.from(apiKey).toString('base64')}`,
    }),
    'Unavailable\nBearer another-secret\nAuthorization: unrelated-secret',
    `<html><title>Denied ${Array.from(apiKey, (c) => `&#${c.charCodeAt(0)};`).join('')}</title><body>${apiKey}</body></html>`,
    `${'x'.repeat(4096)}${apiKey}`,
    `{"error":"${apiKey}`,
    '',
    JSON.stringify({
      type: 't'.repeat(100),
      code: 'c'.repeat(100),
      message: `${'x'.repeat(510)}${apiKey}${'y'.repeat(100)}`,
    }),
  ];
  t.mock.method(globalThis, 'fetch', async () => {
    const body = bodies[calls++];
    return new Response(body, {
      status: 451,
      headers: { Authorization: 'response-header-secret' },
    });
  });
  const collected = [];
  for (const _body of bodies)
    await assert.rejects(
      officialRequest('/v1/systemone', {
        apiKey,
        body: { model: DEFAULT_JEV_MODEL },
      }),
      (error) => {
        assert.match(error.message, /HTTP 451; agent stopped/);
        for (const secret of [
          apiKey,
          'header-secret',
          'field-secret',
          'ignored-cookie',
          'another-secret',
          'unrelated-secret',
          'response-header-secret',
        ])
          assert.ok(!error.message.includes(secret));
        const details = errorDetails(error);
        assert.ok((details.type?.length ?? 0) <= 64);
        assert.ok((details.code?.length ?? 0) <= 64);
        assert.ok((details.message?.length ?? 0) <= 512);
        assert.equal(details.headers, undefined);
        collected.push(details);
        return true;
      },
    );
  assert.equal(calls, bodies.length);
  assert.equal(collected[0].type, 'provider_policy');
  assert.equal(collected[0].code, 'restricted');
  assert.match(collected[0].message, /Access is restricted by provider policy/);
  assert.equal(collected[1].code, '451');
  assert.equal(collected[4].bodyStatus, 'html_title_only');
  assert.equal(collected[5].bodyStatus, 'too_large');
  assert.equal(collected[6].bodyStatus, 'invalid_json');
  assert.equal(collected[7].bodyStatus, 'empty');
  assert.equal(collected[8].type.length, 64);
  assert.equal(collected[8].code.length, 64);
  assert.equal(collected[8].message.length, 512);
  assert.equal(collected[8].message.slice(510), '[r');
});

test('error-body read failures and the two-second deadline preserve the HTTP failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 529 },
    );
  });
  let settled = false;
  const pending = officialRequest('/v1/systemone', { apiKey }).catch(
    (error) => {
      settled = true;
      return error;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(1999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const error = await pending;
  assert.match(error.message, /HTTP 529; agent stopped/);
  assert.equal(errorDetails(error).bodyStatus, 'timed_out');
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(apiKey));
          },
        }),
        { status: 451 },
      ),
  );
  await assert.rejects(
    officialRequest('/v1/systemone', { apiKey }),
    (error) => {
      assert.match(error.message, /HTTP 451/);
      assert.equal(errorDetails(error).bodyStatus, 'read_failed');
      assert.ok(!error.message.includes(apiKey));
      return true;
    },
  );
});

test('an error stream of empty chunks cannot bypass the diagnostic bounds', async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 451 },
      ),
  );
  await assert.rejects(
    officialRequest('/v1/systemone', { apiKey }),
    (error) => {
      assert.equal(errorDetails(error).bodyStatus, 'too_fragmented');
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('official hundredth-rounded distributions preserve values without weakening local validation', () => {
  const raw = answer();
  const move = raw.answers.move;
  move.probabilities = Object.fromEntries(
    Object.keys(ACTIONS).map((action) => [action, 0.11]),
  );
  move.confidence = 0;
  const parsed = parseDecision(raw, { official: true });
  assert.deepEqual(parsed.probabilities, move.probabilities);
  assert.equal(parsed.action, 'left');
  assert.equal(parsed.confidence, 0);
  assert.throws(() => parseDecision(raw), /sum=0.99/);
  move.probabilities.left = 0.13;
  assert.equal(parseDecision(raw, { official: true }).probabilities.left, 0.13);
  for (const value of [0, 0.12, 0.115, -0.1, 1.1]) {
    move.probabilities = Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [action, value]),
    );
    assert.throws(
      () => parseDecision(raw, { official: true }),
      /probability distribution/,
    );
  }
});

test('an official non-maximum Choice is preserved with an explicit warning, never replaced', () => {
  const raw = answer('right_run');
  raw.answers.move.choice = 'left';
  const parsed = parseDecision(raw, { official: true });
  assert.equal(parsed.action, 'left');
  assert.equal(parsed.confidence, raw.answers.move.confidence);
  assert.deepEqual(parsed.probabilities, raw.answers.move.probabilities);
  assert.match(parsed.responseWarning, /differs from the probability maximum/);
  assert.throws(() => parseDecision(raw), /probability distribution/);
});

test('official health authenticates against the fixed models endpoint', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${OFFICIAL_JEV_URL}/v1/models`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Connection, 'close');
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    return response({ models: [{ name: 'jev-latest' }] });
  });
  const health = await checkJev(config.baseURL, config);
  assert.equal(health.engine, 'jev-official');
  assert.equal(health.model, DEFAULT_JEV_MODEL);
  assert.ok(!JSON.stringify(health).includes(apiKey));
});

test('official Game applies the raw choice and keeps credentials out of status and logs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mario-official-game-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const actions = [];
  const raw = answer('right_run');
  raw.answers.move.choice = 'left_jump';
  t.mock.method(globalThis, 'fetch', async () => response(raw));
  const game = new Game({
    ...config,
    logDirectory: directory,
    makeEmulator: () => ({
      ram: ramFixture(),
      frame: 0,
      hash: 'a'.repeat(64),
      boot() {},
      release() {},
      forecast() {
        return null;
      },
      advance(action, frames) {
        actions.push(action);
        this.frame += frames;
        return frames;
      },
    }),
  });

  game.load(Buffer.from('synthetic test ROM'));
  await game.step();
  assert.deepEqual(actions, ['left_jump']);
  assert.equal(game.info().decisionBackend, 'jev-official');
  assert.equal(game.info().requestedModel, DEFAULT_JEV_MODEL);
  assert.match(
    game.info().decision.responseWarning,
    /native Choice is preserved/,
  );
  const log = readFileSync(game.logPath, 'utf8');
  assert.ok(!log.includes(apiKey));
  assert.ok(!JSON.stringify(game).includes(apiKey));
  assert.ok(!JSON.stringify(game.info()).includes(apiKey));
  assert.match(log, /"engine":"jev-official"/);
});

test('redacted provider diagnostics persist while Game stops before applying input', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mario-official-error-'));
  t.after(() => rmSync(directory, { recursive: true }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          code: 'restricted',
          message: `Provider denied access for ${apiKey}`,
        },
      }),
      { status: 451 },
    );
  });
  const game = new Game({
    ...config,
    logDirectory: directory,
    makeEmulator: () => ({
      ram: ramFixture(),
      frame: 0,
      hash: 'a'.repeat(64),
      boot() {},
      release() {},
      forecast() {
        return null;
      },
      advance() {
        assert.fail('HTTP failure must never apply an action');
      },
    }),
  });
  game.load(Buffer.from('synthetic test ROM'));
  await assert.rejects(game.step(), /HTTP 451/);
  const status = game.info();
  assert.equal(status.running, false);
  assert.equal(status.decisions, 0);
  assert.equal(status.pendingApplied, null);
  assert.equal(status.state.episode.frame, 0);
  assert.match(status.error, /Provider denied access/);
  const log = readFileSync(game.logPath, 'utf8');
  assert.match(log, /restricted/);
  assert.match(log, /pre-action/);
  assert.ok(!log.includes(apiKey));
  assert.ok(!JSON.stringify(status).includes(apiKey));
  assert.equal(calls, 1);
});
