import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fetchJSON, listen, loopbackURL } from '../http.mjs';
import {
  createJevServer,
  gemmaDecision,
  validateRequest,
} from '../local-jev.mjs';
import { ACTIONS, choose, decisionRequest, parseDecision } from '../policy.mjs';
import { Telemetry } from '../telemetry.mjs';
import { answer, ramFixture } from './fixtures.mjs';

const state = () => new Telemetry(16).sample(ramFixture(), 0);

function nativeAnswer(action = 'right_run') {
  const result = answer(action);
  result.engine = 'this-that';
  result.model = 'flock-io/this-that-model-1.2';
  result.answers.move.probabilities = Object.fromEntries(
    Object.keys(ACTIONS).map((key) => [key, key === action ? 0.7 : 0.05]),
  );
  result.answers.move.confidence = 0.7;
  return result;
}

async function serve(t, handler) {
  const server =
    typeof handler === 'function' ? createServer(handler) : handler;
  await listen(server, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('exact seven actions and strictly typed answers; no invented confidence', () => {
  assert.equal(Object.keys(ACTIONS).length, 7);
  for (const action of Object.keys(ACTIONS)) {
    const result = parseDecision(answer(action));
    assert.equal(result.action, action);
    assert.equal(result.confidence, null);
    assert.equal(result.dangerScore, null);
  }
  for (const value of [
    null,
    {},
    answer('right; jump'),
    answer(['right']),
    { answers: { ...answer().answers, extra: {} } },
  ])
    assert.throws(() => parseDecision(value));
  for (const value of [
    -0.1,
    1.1,
    '0.5',
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const invalid = answer();
    invalid.answers.jump_needed.noul = value;
    assert.throws(() => parseDecision(invalid), /belief/);
  }
});

test('local-only endpoint policy rejects DNS names, credentials and redirects', async (t) => {
  assert.equal(loopbackURL('http://127.0.0.1:8766/'), 'http://127.0.0.1:8766');
  for (const url of [
    'https://127.0.0.1',
    'http://example.com',
    'http://localhost',
    'http://127.0.0.1.example.com',
    'http://user@127.0.0.1',
    'http://127.0.0.1/?x=1',
    'file:///tmp/a',
  ]) {
    assert.throws(() => loopbackURL(url));
  }
  const url = await serve(t, (_req, res) => {
    res.writeHead(302, { Location: 'https://example.com' });
    res.end();
  });
  await assert.rejects(fetchJSON(url), /fetch failed/);
});

test('existing Jev wire format contains structured JSON only', async (t) => {
  const url = await serve(t, async (req, res) => {
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers['x-link-run-id'], 'probe');
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(request.assets, undefined);
    assert.equal(request.state.game.player.x, 40);
    validateRequest(request);
    res.end(JSON.stringify(nativeAnswer('left')));
  });
  const decision = await choose(state(), { baseURL: url, runId: 'probe' });
  assert.equal(
    decision.action,
    'left',
    'choice is not replaced by a recovery rule',
  );
  assert.ok(decision.latencyMs >= 0);
});

test('Gemma request configuration, schema, finish reason and validation', async (t) => {
  let finish = 'stop';
  const url = await serve(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(request.temperature, 0);
    assert.equal(request.enable_thinking, false);
    assert.equal(request.stream, false);
    assert.equal(request.max_tokens, 768);
    assert.equal(request.model, 'test-model');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.messages.length, 2);
    assert.equal(typeof request.messages[1].content, 'string');
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: finish,
            message: { content: JSON.stringify(answer()) },
          },
        ],
      }),
    );
  });
  const options = { baseURL: `${url}/v1`, model: 'test-model' };
  assert.equal(
    (await gemmaDecision(decisionRequest(state()), options)).answers.move
      .choice,
    'right_run',
  );
  finish = 'length';
  await assert.rejects(
    gemmaDecision(decisionRequest(state()), options),
    /finish/,
  );
  await assert.rejects(
    gemmaDecision({ ...decisionRequest(state()), assets: {} }, options),
    /no image/,
  );
  await assert.rejects(
    gemmaDecision(decisionRequest(state()), {
      ...options,
      baseURL: 'https://example.com',
    }),
    /loopback/,
  );
});

test('HTTP failures and aborts do not become a fallback action', async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(429);
    res.end('busy');
  });
  await assert.rejects(choose(state(), { baseURL: url, runId: 'test' }), /429/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    choose(state(), { baseURL: url, runId: 'test', signal: controller.signal }),
    /cancelled/,
  );
});

test('legacy Gemma bridge still works but is rejected as a this-that fallback', async (t) => {
  const upstream = await serve(t, (req, res) => {
    if (req.url === '/v1/models')
      res.end(JSON.stringify({ data: [{ id: 'model' }] }));
    else
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(answer('jump')) },
            },
          ],
        }),
      );
  });
  const events = [];
  const bridge = await serve(
    t,
    createJevServer({
      baseURL: `${upstream}/v1`,
      model: 'model',
      log: (event) => events.push(event),
    }),
  );
  assert.equal((await fetchJSON(`${bridge}/health`)).ready, true);
  await assert.rejects(
    choose(state(), { baseURL: bridge, runId: 'bridge-test' }),
    /different decision backend/,
  );
  assert.deepEqual(
    events.map((event) => event.kind),
    ['request', 'response'],
  );
  const denied = await fetch(`${bridge}/v1/systemone`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(decisionRequest(state())),
  });
  assert.equal(denied.status, 403);
});

test('native probabilities are preserved and confidence is the selected-option probability', () => {
  for (const action of Object.keys(ACTIONS)) {
    const input = nativeAnswer(action);
    const result = parseDecision(input);
    assert.equal(result.action, action);
    assert.equal(result.confidence, 0.7);
    assert.deepEqual(result.probabilities, input.answers.move.probabilities);
  }
  for (const mutate of [
    (move) => {
      move.probabilities = Object.fromEntries(
        Object.entries(move.probabilities).filter(([key]) => key !== 'noop'),
      );
    },
    (move) => {
      move.probabilities.extra = 0;
    },
    (move) => {
      move.probabilities.noop = -0.1;
    },
    (move) => {
      move.probabilities.noop = Number.NaN;
    },
    (move) => {
      move.probabilities.noop = '0.05';
    },
    (move) => {
      move.probabilities.noop = 0.2;
    },
    (move) => {
      move.choice = 'left';
    },
    (move) => {
      move.confidence = 0.9;
    },
    (move) => {
      move.probabilities = undefined;
    },
  ]) {
    const input = nativeAnswer();
    mutate(input.answers.move);
    assert.throws(() => parseDecision(input), /distribution/);
  }
});

test('this-that identity does not excuse missing native probabilities', async (t) => {
  const result = {
    ...answer(),
    engine: 'this-that',
    model: 'flock-io/this-that-model-1.2',
  };
  const url = await serve(t, (_req, res) => res.end(JSON.stringify(result)));
  await assert.rejects(
    choose(state(), { baseURL: url, runId: 'missing-probabilities' }),
    /actual action probability/,
  );
});
