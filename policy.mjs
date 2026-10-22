import { compactState } from './compact-state.mjs';
import { fetchJSON, loopbackURL } from './http.mjs';

export const ACTIONS = Object.freeze({
  noop: [],
  right: [7],
  right_jump: [7, 0],
  right_run: [7, 1],
  right_run_jump: [7, 1, 0],
  jump: [0],
  left: [6],
});

export function decisionRequest(state) {
  const criteria = Object.fromEntries(
    Object.keys(ACTIONS).map((action) => [action, action]),
  );
  const modelState = { game: compactState(state) };
  if (state.forecast) {
    modelState.outcomes = {};
    for (const action of Object.keys(ACTIONS)) {
      const { next, held, jumpReadyNext, noSurvivingFollowup } =
        state.forecast.moves[action];
      if (typeof jumpReadyNext !== 'boolean')
        throw new Error(`Missing jump readiness forecast for ${action}.`);
      modelState.outcomes[action] = {
        aliveNext: next[2] !== 'dead',
        aliveHeld: held[2] !== 'dead',
        trap: Boolean(noSurvivingFollowup),
        forwardNext: next[0],
        forwardHeld: held[0],
        jumpReadyNext,
      };
    }
  }
  return {
    state: modelState,
    questions: {
      move: {
        type: 'choice',
        instructions: state.forecast
          ? 'Choose an action using the forecast facts. First prefer aliveNext=true and trap=false. Among those, prefer aliveHeld=true. Then choose the greatest forwardNext; break ties by greatest forwardHeld, then jumpReadyNext=true. Zero forward progress loses to positive progress when survival is equal. Return the action name, not a description.'
          : 'Choose an action to move Mario right while avoiding enemies and gaps; prioritize survival over progress. This synthetic protocol probe has no simulated action forecasts. Coordinates are pixels, with positive y downward. Enemy projectedDx is after the action interval: crossing zero is not safety.',
        criteria,
      },
      jump_needed: {
        type: 'noul',
        instructions:
          'Does starting or holding a forward jump help Mario survive and advance now?',
      },
    },
  };
}

export function parseDecision(result) {
  const answers = result?.answers;
  if (!answers || Object.keys(answers).sort().join(',') !== 'jump_needed,move')
    throw new Error(
      'Decision service must return exactly move and jump_needed answers.',
    );
  const move = answers.move;
  const jump = answers.jump_needed;
  if (
    move?.type !== 'choice' ||
    typeof move.choice !== 'string' ||
    !Object.hasOwn(ACTIONS, move.choice)
  )
    throw new Error('Decision service returned an invalid controller choice.');
  if (
    jump?.type !== 'noul' ||
    !Number.isFinite(jump.noul) ||
    jump.noul < 0 ||
    jump.noul > 1
  )
    throw new Error('Decision service returned an invalid jump belief.');
  const probabilities = move.probabilities ?? null;
  if (probabilities !== null) {
    if (
      typeof probabilities !== 'object' ||
      Array.isArray(probabilities) ||
      Object.keys(probabilities).sort().join(',') !==
        Object.keys(ACTIONS).sort().join(',') ||
      Object.values(probabilities).some(
        (p) => !Number.isFinite(p) || p < 0 || p > 1,
      ) ||
      Math.abs(
        Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1,
      ) > 1e-5 ||
      probabilities[move.choice] < Math.max(...Object.values(probabilities)) ||
      (move.confidence !== undefined &&
        (!Number.isFinite(move.confidence) ||
          Math.abs(move.confidence - probabilities[move.choice]) > 1e-5))
    )
      throw new Error(
        'Decision service returned an invalid action probability distribution.',
      );
  } else if (move.confidence !== undefined) {
    throw new Error(
      'Decision service returned confidence without an action distribution.',
    );
  }
  return {
    action: move.choice,
    jumpNeeded: jump.noul,
    confidence: probabilities?.[move.choice] ?? null,
    probabilities,
    dangerScore: null,
  };
}

export async function choose(state, { baseURL, runId, signal }) {
  const started = performance.now();
  const request = decisionRequest(state);
  const raw = await fetchJSON(`${loopbackURL(baseURL)}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-link-run-id': runId },
    body: JSON.stringify(request),
    signal,
  });
  if (
    raw.engine !== 'this-that' ||
    raw.model !== 'flock-io/this-that-model-1.2'
  )
    throw new Error(
      'Expected local this-that-model-1.2; refusing a different decision backend.',
    );
  const decision = parseDecision(raw);
  if (!decision.probabilities)
    throw new Error(
      'This-that must return its actual action probability distribution.',
    );
  return {
    ...decision,
    latencyMs: performance.now() - started,
    raw,
    modelInput: request.state,
    modelQuestions: request.questions,
    inputStats: {
      fullStateChars: JSON.stringify(state).length,
      sentStateChars: JSON.stringify(request.state).length,
      inputTokens: raw.usage?.input_tokens ?? null,
    },
  };
}

export async function checkJev(baseURL) {
  const health = await fetchJSON(`${loopbackURL(baseURL)}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (health.ready !== true)
    throw new Error('Decision service reports that its model is not ready.');
  if (
    health.engine !== 'this-that' ||
    health.model !== 'flock-io/this-that-model-1.2'
  )
    throw new Error(
      'Expected local this-that-model-1.2; this service is a different backend.',
    );
  return health;
}
