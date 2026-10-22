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
  const criteria = {
    noop: 'Release buttons.',
    right: 'Walk right.',
    right_jump: 'Right + A (jump).',
    right_run: 'Right + B (run).',
    right_run_jump: 'Right + B + A (run and jump).',
    jump: 'A (jump).',
    left: 'Left (brake/reverse).',
  };
  if (state.forecast) {
    for (const action of Object.keys(criteria)) {
      const { next, held, jumpReadyNext, noSurvivingFollowup } =
        state.forecast.moves[action];
      if (typeof jumpReadyNext !== 'boolean')
        throw new Error(`Missing jump readiness forecast for ${action}.`);
      const outcome =
        next[2] === 'dead'
          ? 'DEAD within Next.'
          : noSurvivingFollowup
            ? 'TRAP: every follow-up dies.'
            : held[2] === 'dead'
              ? 'DIES if held; a later change is necessary.'
              : 'ALIVE through Next and Held.';
      criteria[action] = `${outcome} ${criteria[action]}`;
      criteria[action] +=
        ` Next: ${next[0]} pixels forward, y=${next[1]}, ${next[2]}. Held: ${held[0]} pixels forward, y=${held[1]}, ${held[2]}.`;
      criteria[action] +=
        ` Can start a fresh jump after Next: ${jumpReadyNext ? 'yes' : 'no'}.`;
      if (state.player.grounded && state.recent_control.heldJump)
        criteria[action] += action.includes('jump')
          ? ' A was already held: this does NOT start a new jump and keeps A unarmed.'
          : ' Releases held A so a subsequent grounded jump can start.';
      if (state.forecast.moves[action].noSurvivingFollowup)
        criteria[action] +=
          ' TRAP: after Next, all seven possible follow-up actions die within another decision interval.';
    }
  }
  return {
    state: {
      goal: 'SMB1: survive and advance right. Pixels, +y down, velocities in pixels/frame; solids=[left,top,right,bottom], gaps=[left,right]. Unknown outside observedX. Simulation pauses for inference; hold chosen action for frames. Enemy projectedDx is enemy-player dx after frames: crossing zero is not safety. contactInFrames estimates time to contact. Memory is factual excerpts: count=consecutive decisions; outcome describes the whole episode, not each step. Learn from failures without blindly replaying them.',
      game: compactState(state),
    },
    questions: {
      move: {
        type: 'choice',
        instructions: `Prioritize survival over progress. Compare EVERY option: Next is after ${state.reaction_timing.framesPerDecision} frames, Held after ${state.forecast?.heldFor ?? state.reaction_timing.framesPerDecision} frames without replanning. These are isolated simulations, not live actions. Avoid Next deaths AND TRAP actions, even if they advance farther. Prefer surviving both Next and Held, then larger safe forward displacement. A rising jump is useful progress; grounded is not inherently safer. Never repeat zero movement when another option survives and advances. If equally useful, prefer running on clear ground. When grounded with heldA, release A to rearm a new jump. No action is preselected or overridden.`,
        criteria,
      },
      jump_needed: {
        type: 'noul',
        instructions:
          'Belief [0,1] that starting/holding a forward jump helps now. Display only.',
      },
    },
  };
}

export function parseDecision(result) {
  const answers = result?.answers;
  if (!answers || Object.keys(answers).sort().join(',') !== 'jump_needed,move')
    throw new Error('Jev must return exactly move and jump_needed answers.');
  const move = answers.move;
  const jump = answers.jump_needed;
  if (
    move?.type !== 'choice' ||
    typeof move.choice !== 'string' ||
    !Object.hasOwn(ACTIONS, move.choice)
  )
    throw new Error('Jev returned an invalid controller choice.');
  if (
    jump?.type !== 'noul' ||
    !Number.isFinite(jump.noul) ||
    jump.noul < 0 ||
    jump.noul > 1
  )
    throw new Error('Jev returned an invalid jump belief.');
  return {
    action: move.choice,
    jumpNeeded: jump.noul,
    // The local compatible protocol does not return these official SDK fields.
    confidence: null,
    probabilities: null,
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
  return {
    ...parseDecision(raw),
    latencyMs: performance.now() - started,
    raw,
    modelInput: request.state.game,
    modelQuestions: request.questions,
    inputStats: {
      fullStateChars: JSON.stringify(state).length,
      sentStateChars: JSON.stringify(request.state.game).length,
      inputTokens: raw.usage?.input_tokens ?? null,
    },
  };
}

export async function checkJev(baseURL) {
  const health = await fetchJSON(`${loopbackURL(baseURL)}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (health.ready !== true)
    throw new Error('Jev reports that its model is not ready.');
  return health;
}
