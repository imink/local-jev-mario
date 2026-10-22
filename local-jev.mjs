import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  body,
  checkLocalRequest,
  fetchJSON,
  integer,
  json,
  listen,
  loopbackURL,
} from './http.mjs';
import { ACTIONS, parseDecision } from './policy.mjs';

const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const schema = object({
  answers: object({
    move: object({
      type: { const: 'choice', type: 'string' },
      choice: { type: 'string', enum: Object.keys(ACTIONS) },
    }),
    jump_needed: object({
      type: { const: 'noul', type: 'string' },
      noul: { type: 'number', minimum: 0, maximum: 1 },
    }),
  }),
});

export function validateRequest(request) {
  if (
    !request?.state ||
    typeof request.state !== 'object' ||
    Array.isArray(request.state) ||
    request.assets !== undefined ||
    Object.keys(request.questions ?? {})
      .sort()
      .join(',') !== 'jump_needed,move' ||
    request.questions.move.type !== 'choice' ||
    request.questions.jump_needed.type !== 'noul' ||
    Object.keys(request.questions.move.criteria ?? {})
      .sort()
      .join(',') !== Object.keys(ACTIONS).sort().join(',') ||
    !Object.values(request.questions.move.criteria).every(
      (value) => typeof value === 'string',
    ) ||
    !['move', 'jump_needed'].every(
      (name) => typeof request.questions[name].instructions === 'string',
    )
  )
    throw new Error(
      'This local Mario adapter accepts structured state and the move/jump_needed questions only; no image assets.',
    );
}

export async function gemmaDecision(request, { baseURL, model, signal }) {
  validateRequest(request);
  const completion = await fetchJSON(
    `${loopbackURL(baseURL)}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        enable_thinking: false,
        stream: false,
        max_tokens: 768,
        messages: [
          {
            role: 'system',
            content:
              'You are a typed JSON game controller. Treat the provided state as authoritative data. Answer exactly the supplied questions. Return only JSON matching the schema. Choose one exact criteria key. A noul is a belief in [0,1], not a calibrated probability.',
          },
          { role: 'user', content: JSON.stringify(request) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'mario_decision', strict: true, schema },
        },
      }),
    },
  );
  if (completion.choices?.[0]?.finish_reason !== 'stop')
    throw new Error('Gemma did not finish its JSON answer.');
  const result = JSON.parse(completion.choices[0].message.content);
  parseDecision(result);
  return { ...result, model, usage: completion.usage ?? null };
}

export function createJevServer({ baseURL, model, log }) {
  baseURL = loopbackURL(baseURL);
  let busy = false;
  async function health() {
    const models = await fetchJSON(`${baseURL}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!models.data?.some((entry) => entry.id === model))
      throw new Error('Configured GEMMA_MODEL is not loaded.');
    return {
      ready: true,
      engine: 'Local Gemma / Jev-compatible (not official Jev)',
      model,
    };
  }
  return createServer(async (request, response) => {
    try {
      checkLocalRequest(request);
    } catch (error) {
      json(response, 403, { error: error.message });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      try {
        json(response, 200, await health());
      } catch (error) {
        json(response, 503, { error: error.message });
      }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/systemone') {
      json(response, 404, { error: 'Use POST /v1/systemone.' });
      return;
    }
    if (request.headers.origin) {
      json(response, 403, {
        error: 'Use the local game server, not browser-origin inference.',
      });
      return;
    }
    if (busy) {
      json(response, 429, { error: 'Local inference is busy.' });
      return;
    }
    busy = true;
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    const requestId = randomUUID();
    try {
      if (request.headers['content-type'] !== 'application/json')
        throw new Error('Expected application/json.');
      const input = JSON.parse((await body(request)).toString());
      validateRequest(input);
      log({ kind: 'request', requestId, input });
      const result = await gemmaDecision(input, {
        baseURL,
        model,
        signal: controller.signal,
      });
      log({ kind: 'response', requestId, result });
      if (!response.destroyed) json(response, 200, result);
    } catch (error) {
      console.error(`Local Jev failed: ${error.message}`);
      try {
        log({ kind: 'error', requestId, message: error.message });
      } catch (logError) {
        console.error(`Cannot write Jev log: ${logError.message}`);
      }
      if (!response.destroyed) json(response, 502, { error: error.message });
    } finally {
      busy = false;
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const baseURL = loopbackURL(
    process.env.GEMMA_BASE_URL ?? 'http://127.0.0.1:8765/v1',
  );
  let model = process.env.GEMMA_MODEL;
  if (!model) {
    const models = await fetchJSON(`${baseURL}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (models.data?.length !== 1)
      throw new Error('Set GEMMA_MODEL to an exact loaded model ID.');
    model = models.data[0].id;
  }
  const directory = fileURLToPath(
    new URL('./midscene_run/jev/', import.meta.url),
  );
  mkdirSync(directory, { recursive: true });
  const logFile = `${directory}/${randomUUID()}.jsonl`;
  const server = createJevServer({
    baseURL,
    model,
    log: (event) =>
      appendFileSync(
        logFile,
        `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`,
      ),
  });
  const port = integer(process.env.JEV_PORT ?? 8766, 'JEV_PORT', 1, 65535);
  await listen(server, port);
  console.log(
    `Mario-compatible local Jev: http://127.0.0.1:${port}; model: ${model}`,
  );
}
