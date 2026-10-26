import { compactState } from './compact-state.mjs';
import { fetchJSON, loopbackURL } from './http.mjs';
import {
  DEFAULT_JEV_MODEL,
  OFFICIAL_JEV_URL,
  officialRequest,
} from './official-jev.mjs';
import { sameNavigationPosition } from './telemetry.mjs';

export const ACTIONS = Object.freeze({
  noop: [],
  right: [7],
  right_jump: [7, 0],
  right_run: [7, 1],
  right_run_jump: [7, 1, 0],
  jump: [0],
  left: [6],
  down: [5],
  left_jump: [6, 0],
});

export function decisionRequest(state) {
  const criteria = Object.fromEntries(
    Object.keys(ACTIONS).map((action) => [action, action]),
  );
  const modelState = { game: compactState(state) };
  let focus = null;
  if (state.forecast) {
    modelState.predictionScope = {
      firstActionFrames: state.forecast.frames,
      continuationFrames: state.forecast.continuationFrames,
      readinessSamplingFrames: state.forecast.frames,
      readinessLookaheadFrames: state.forecast.readyStateLookaheadFrames,
      heldForFrames: state.forecast.heldFor,
      ...(state.forecast.narrowSupportLookaheadFrames !== undefined
        ? {
            narrowSupportLookaheadFrames:
              state.forecast.narrowSupportLookaheadFrames,
            narrowSupportSamplingFrames:
              state.forecast.narrowSupportSamplingFrames,
            narrowSupportBeamWidth: state.forecast.narrowSupportBeamWidth,
            narrowSupportPreparationLookaheadFrames:
              state.forecast.narrowSupportPreparationLookaheadFrames,
            narrowSupportValidationFrames:
              state.forecast.narrowSupportValidationFrames,
          }
        : {}),
      ...(state.forecast.pipeEntryLookaheadFrames !== undefined
        ? {
            pipeEntryLookaheadFrames: state.forecast.pipeEntryLookaheadFrames,
            pipeAutomaticFrameLimit: state.forecast.pipeAutomaticFrameLimit,
          }
        : {}),
      missingReadinessWitness:
        'No qualifying boundary found within this bounded search; survival is unknown, not proven impossible.',
    };
    const mazeFloors = state.navigation.mazeRoute?.alternativeFloorYs ?? [];
    const mazeCheckpoint = state.navigation.mazeFeedback?.checkpoints.find(
      (point) => point.page === state.navigation.mazeRoute?.checkpointPage,
    );
    const unresolvedMazeCheckpoint =
      mazeCheckpoint &&
      mazeCheckpoint.correctFloorYs.length === 0 &&
      state.episode.stalledFrames >= 180;
    const failedMazeSequence =
      state.navigation.mazeFeedback?.checkedInSequence >
      state.navigation.mazeFeedback?.correctInSequence;
    const newMazeFeedback = (check) =>
      mazeCheckpoint &&
      check.page === mazeCheckpoint.page &&
      typeof check.correct === 'boolean' &&
      Number.isFinite(check.floorY) &&
      !mazeCheckpoint.correctFloorYs.includes(check.floorY) &&
      !mazeCheckpoint.failedFloorYs.includes(check.floorY);
    const climbing =
      Boolean(state.navigation.climbFloors?.length) ||
      state.navigation.higherLandingY !== undefined;
    const runJump = state.navigation.runJumpTargetX !== undefined;
    const nearSpringboard = state.hazard.enemies.some(
      (enemy) => enemy.kind === 0x32 && Math.abs(enemy.dx) < 64,
    );
    const movesBodyLength = (dx, y) =>
      Math.abs(dx) >= 16 || Math.abs(y - state.player.y) >= state.player.height;
    modelState.outcomes = {};
    for (const action of Object.keys(ACTIONS)) {
      const {
        next,
        held,
        jumpReadyNext,
        noSurvivingFollowup,
        survivesWithOneReplan,
        pipeProgress,
        pipeEntryFrames,
        revealsHiddenBlock,
        hiddenBlockReadyFrames,
        supportLanding,
        supportLandingFrames,
        areaDestination,
      } = state.forecast.moves[action];
      if (
        (state.navigation.narrowSupports?.length &&
          typeof supportLanding !== 'boolean') ||
        (supportLanding &&
          (!Number.isInteger(supportLandingFrames) || supportLandingFrames < 1))
      )
        throw new Error(
          `Missing or invalid narrow support landing for ${action}.`,
        );
      if (
        revealsHiddenBlock &&
        (!Number.isInteger(hiddenBlockReadyFrames) ||
          hiddenBlockReadyFrames < 1)
      )
        throw new Error(
          `Missing or invalid hidden block readiness for ${action}.`,
        );
      if (
        pipeProgress &&
        (!Number.isInteger(pipeEntryFrames) || pipeEntryFrames < 1)
      )
        throw new Error(
          `Missing or invalid pipe entry duration for ${action}.`,
        );
      const hasSafeMazeFeedback = (predicate) =>
        next[2] !== 'dead' &&
        !noSurvivingFollowup &&
        survivesWithOneReplan &&
        ((state.forecast.moves[action].mazeCheckpointFeedbackNext ?? []).some(
          predicate,
        ) ||
          (held[2] !== 'dead' &&
            next[0] > 0 &&
            (
              state.forecast.moves[action].mazeCheckpointFeedbackHeld ?? []
            ).some(predicate)));
      if (
        mazeFloors.length &&
        (typeof state.forecast.moves[action].mazeLanding !== 'boolean' ||
          typeof state.forecast.moves[action].mazeConnectedLanding !==
            'boolean')
      )
        throw new Error(
          `Missing observed maze landing forecast for ${action}.`,
        );
      if (typeof jumpReadyNext !== 'boolean')
        throw new Error(`Missing jump readiness forecast for ${action}.`);
      if (
        climbing &&
        typeof state.forecast.moves[action].climbLanding !== 'boolean'
      )
        throw new Error(`Missing climbing landing forecast for ${action}.`);
      if (
        runJump &&
        typeof state.forecast.moves[action].runJumpLanding !== 'boolean'
      )
        throw new Error(`Missing run-jump landing forecast for ${action}.`);
      if (typeof survivesWithOneReplan !== 'boolean')
        throw new Error(
          `Missing continuation survival forecast for ${action}.`,
        );
      const entersArea = state.forecast.moves[action].entersArea === true;
      if (
        entersArea &&
        (!Array.isArray(areaDestination) ||
          areaDestination.length !== 2 ||
          !Number.isInteger(areaDestination[0]) ||
          areaDestination[0] < 1 ||
          areaDestination[0] > 8 ||
          !Number.isInteger(areaDestination[1]) ||
          areaDestination[1] < 1 ||
          areaDestination[1] > 4)
      )
        throw new Error(`Missing or invalid pipe destination for ${action}.`);
      const levelDelta = entersArea
        ? (areaDestination[0] - state.player.world) * 4 +
          areaDestination[1] -
          state.player.stage
        : 0;
      const blockedHeld = state.navigation.blockedPositions.some((position) =>
        sameNavigationPosition(position, {
          x: state.player.x + held[0],
          y: held[1],
        }),
      );
      const blockedNext = state.navigation.blockedPositions.some((position) =>
        sameNavigationPosition(position, {
          x: state.player.x + next[0],
          y: next[1],
        }),
      );
      modelState.outcomes[action] = {
        aliveNext: next[2] !== 'dead',
        aliveHeld: held[2] !== 'dead',
        groundedHeld: held[2] === 'grounded',
        trap: Boolean(noSurvivingFollowup),
        ...(pipeProgress !== undefined
          ? {
              pipeProgress:
                next[2] !== 'dead' && !noSurvivingFollowup && pipeProgress,
              ...(pipeProgress ? { pipeEntryFrames } : {}),
            }
          : {}),
        survivesWithOneReplan,
        ...(supportLanding !== undefined
          ? {
              supportLanding:
                next[2] !== 'dead' && !noSurvivingFollowup && supportLanding,
              ...(supportLanding ? { supportLandingFrames } : {}),
            }
          : {}),
        ...(revealsHiddenBlock !== undefined
          ? {
              revealsHiddenBlock:
                next[2] !== 'dead' &&
                !noSurvivingFollowup &&
                revealsHiddenBlock,
              ...(revealsHiddenBlock ? { hiddenBlockReadyFrames } : {}),
            }
          : {}),
        forwardNext: next[0],
        forwardHeld: held[0],
        jumpReadyNext,
        clearsLevel: state.forecast.moves[action].clearsLevel === true,
        entersArea,
        ...(state.forecast.moves[action].returnsWithinArea
          ? { returnsWithinArea: true }
          : {}),
        preservesLevelSequence: levelDelta === 0 || levelDelta === 1,
        nextY: next[1],
        heldY: held[1],
        blockedHeld,
        blockedNext,
        avoidsKnownBlockage: !blockedHeld,
        movesHeld: held[0] !== 0 || held[1] !== state.player.y,
        movesBodyLength:
          movesBodyLength(next[0], next[1]) ||
          movesBodyLength(held[0], held[1]),
        ...(climbing
          ? { climbLanding: state.forecast.moves[action].climbLanding }
          : {}),
        ...(runJump
          ? { runJumpLanding: state.forecast.moves[action].runJumpLanding }
          : {}),
        ...(mazeFloors.length
          ? {
              mazeLanding: state.forecast.moves[action].mazeLanding === true,
              mazeConnectedLanding:
                state.forecast.moves[action].mazeConnectedLanding === true,
              repeatsMaze: state.forecast.moves[action].repeatsMaze === true,
              ...(state.forecast.moves[action].mazeCheckpointFailedNext
                ? { mazeCheckpointFailedNext: true }
                : {}),
              ...(unresolvedMazeCheckpoint
                ? {
                    revealsMazeCheckpoint: hasSafeMazeFeedback(newMazeFeedback),
                  }
                : {}),
              ...(failedMazeSequence
                ? {
                    retriesFailedMazeSequence: hasSafeMazeFeedback(
                      (check) =>
                        check.sequenceEnded && check.sequenceCorrect === false,
                    ),
                  }
                : {}),
              groundedMazeReset:
                state.forecast.moves[action].groundedMazeReset === true,
            }
          : {}),
        ...(nearSpringboard
          ? {
              reachesObstacleHeight:
                state.terrain.obstacleAhead !== null &&
                (state.forecast.moves[action].highestY ??
                  Math.min(next[1], held[1])) +
                  state.player.height <=
                  state.terrain.obstacleAhead.topY,
            }
          : {}),
        ...(state.player.swimming
          ? {
              startsSwimStroke:
                state.recent_control.jumpReady &&
                action.includes('jump') &&
                next[1] < state.player.y,
            }
          : {}),
      };
    }
    const outcomes = Object.values(modelState.outcomes);
    const viableNext = (outcome) => outcome.aliveNext && !outcome.trap;
    const safeRequiredRoute = (outcome) =>
      viableNext(outcome) && outcome.preservesLevelSequence;
    const risesSafely = (outcome) =>
      viableNext(outcome) && outcome.nextY < state.player.y;
    const springHeight = (outcome) =>
      viableNext(outcome) && outcome.reachesObstacleHeight === true;
    const rearmsJump = (outcome) =>
      viableNext(outcome) && outcome.jumpReadyNext;
    const usefulMazeMotion = (outcome) =>
      viableNext(outcome) &&
      (!outcome.repeatsMaze || outcome.groundedMazeReset) &&
      (outcome.movesBodyLength ||
        (!state.recent_control.jumpReady && outcome.jumpReadyNext));
    const connectedRouteAvailable = outcomes.some(
      (outcome) => usefulMazeMotion(outcome) && outcome.mazeConnectedLanding,
    );
    const towardMazeRoute = (outcome) =>
      usefulMazeMotion(outcome) &&
      (connectedRouteAvailable
        ? outcome.mazeConnectedLanding
        : outcome.mazeLanding);
    const forwardWaterDrop =
      state.player.swimming &&
      Object.entries(state.forecast.moves).some(
        ([action, move]) =>
          action.startsWith('right') &&
          ['falling', 'dead'].includes(move.held[2]) &&
          move.held[1] + state.player.height >= 240,
      );
    const witnessed = (outcome) =>
      viableNext(outcome) && outcome.survivesWithOneReplan;
    const heldSurvivalWitness = (outcome) =>
      viableNext(outcome) && outcome.aliveHeld;
    const movingSurvivalWitness = (outcome) =>
      witnessed(outcome) &&
      (movesBodyLength(outcome.forwardNext, outcome.nextY) ||
        (outcome.aliveHeld && outcome.movesBodyLength) ||
        outcome.startsSwimStroke === true);
    const rearmedSurvivalWitness = (outcome) =>
      witnessed(outcome) &&
      !state.recent_control.jumpReady &&
      outcome.jumpReadyNext;
    const airborneSurvivalWitness = (outcome) =>
      !state.player.grounded && witnessed(outcome);
    const forwardSurvivalWitness = (outcome) =>
      movingSurvivalWitness(outcome) &&
      outcome.forwardNext > 0 &&
      !outcome.returnsWithinArea &&
      !outcome.blockedNext;
    const horizontalSurvivalWitness = (outcome) =>
      witnessed(outcome) &&
      ((!outcome.blockedNext && Math.abs(outcome.forwardNext) >= 16) ||
        (outcome.groundedHeld &&
          !outcome.blockedHeld &&
          Math.abs(outcome.forwardHeld) >= 16));
    const climbingWitness = (outcome) =>
      viableNext(outcome) &&
      outcome.climbLanding &&
      (outcome.movesBodyLength ||
        (!state.recent_control.jumpReady && outcome.jumpReadyNext));
    const runJumpWitness = (outcome) =>
      viableNext(outcome) &&
      outcome.runJumpLanding &&
      (outcome.movesBodyLength ||
        (!state.recent_control.jumpReady && outcome.jumpReadyNext));
    const avoidsBlockAndMoves = (outcome) =>
      viableNext(outcome) &&
      ((!outcome.blockedHeld &&
        (outcome.movesBodyLength || outcome.startsSwimStroke === true)) ||
        (!outcome.blockedNext &&
          (outcome.startsSwimStroke === true ||
            Math.abs(outcome.forwardNext) >= 16 ||
            Math.abs(outcome.nextY - state.player.y) >= state.player.height ||
            (!state.recent_control.jumpReady &&
              outcome.jumpReadyNext &&
              (outcome.forwardNext !== 0 ||
                outcome.nextY !== state.player.y)))));
    if (outcomes.some((outcome) => !outcome.preservesLevelSequence))
      focus = outcomes.some(safeRequiredRoute)
        ? 'safeRequiredRoute'
        : 'preservesLevelSequence';
    else if (
      failedMazeSequence &&
      outcomes.some((outcome) => outcome.retriesFailedMazeSequence) &&
      !outcomes.every((outcome) => outcome.retriesFailedMazeSequence)
    )
      focus = 'retriesFailedMazeSequence';
    else if (
      state.navigation.observedLoopCount &&
      outcomes.some((outcome) => viableNext(outcome) && outcome.pipeProgress)
    )
      focus = 'pipeProgress';
    else if (
      state.navigation.observedLoopCount &&
      outcomes.some((outcome) => outcome.supportLanding)
    )
      focus = 'supportLanding';
    else if (
      state.navigation.observedLoopCount &&
      outcomes.some((outcome) => outcome.revealsHiddenBlock)
    )
      focus = 'revealsHiddenBlock';
    else if (
      nearSpringboard &&
      outcomes.some(movingSurvivalWitness) &&
      !outcomes.every(witnessed)
    )
      focus = 'movingSurvivalWitness';
    else if (
      nearSpringboard &&
      outcomes.some(rearmedSurvivalWitness) &&
      !outcomes.every(witnessed)
    )
      focus = 'rearmedSurvivalWitness';
    else if (
      nearSpringboard &&
      outcomes.some(airborneSurvivalWitness) &&
      !outcomes.every(witnessed)
    )
      focus = 'airborneSurvivalWitness';
    else if (
      nearSpringboard &&
      outcomes.some(springHeight) &&
      !outcomes.every(springHeight)
    )
      focus = 'springHeight';
    else if (
      nearSpringboard &&
      state.recent_control.heldJump &&
      outcomes.some(rearmsJump) &&
      !outcomes.every(rearmsJump)
    )
      focus = 'rearmsSpring';
    else if (
      runJump &&
      outcomes.some(runJumpWitness) &&
      !outcomes.every(runJumpWitness)
    )
      focus = 'runJumpWitness';
    else if (
      climbing &&
      outcomes.some(climbingWitness) &&
      !outcomes.every(climbingWitness)
    )
      focus = 'climbingWitness';
    else if (
      !state.player.swimming &&
      mazeFloors.length === 0 &&
      state.episode.stalledFrames >= 180 &&
      outcomes.some(horizontalSurvivalWitness) &&
      !outcomes.every(horizontalSurvivalWitness)
    )
      focus = 'horizontalSurvivalWitness';
    else if (
      mazeFloors.length &&
      outcomes.some(forwardSurvivalWitness) &&
      (!outcomes.every(witnessed) ||
        (!connectedRouteAvailable &&
          state.player.x < state.navigation.mazeRoute.gateX - 64 &&
          outcomes.some(
            (outcome) =>
              (outcome.forwardNext > 0 && outcome.blockedNext) ||
              (outcome.forwardHeld > 0 && outcome.blockedHeld),
          )))
    )
      focus = 'forwardSurvivalWitness';
    else if (outcomes.some(movingSurvivalWitness) && !outcomes.every(witnessed))
      focus = 'movingSurvivalWitness';
    else if (
      outcomes.some(rearmedSurvivalWitness) &&
      !outcomes.every(witnessed)
    )
      focus = 'rearmedSurvivalWitness';
    else if (
      outcomes.some(airborneSurvivalWitness) &&
      !outcomes.every(witnessed)
    )
      focus = 'airborneSurvivalWitness';
    else if (
      !outcomes.some(witnessed) &&
      outcomes.some(heldSurvivalWitness) &&
      !outcomes.every(heldSurvivalWitness)
    )
      focus = 'heldSurvivalWitness';
    else if (outcomes.some(viableNext) && !outcomes.every(viableNext))
      focus = 'viableNext';
    else if (
      outcomes.some((outcome) => outcome.aliveNext) &&
      !outcomes.every((outcome) => outcome.aliveNext)
    )
      focus = 'aliveNext';
    else if (
      unresolvedMazeCheckpoint &&
      outcomes.some((outcome) => outcome.revealsMazeCheckpoint) &&
      !outcomes.every((outcome) => outcome.revealsMazeCheckpoint)
    )
      focus = 'revealsMazeCheckpoint';
    else if (
      mazeFloors.length &&
      outcomes.some(towardMazeRoute) &&
      !outcomes.every(towardMazeRoute)
    )
      focus = 'towardMazeRoute';
    else if (
      forwardWaterDrop &&
      state.recent_control.heldJump &&
      outcomes.some(rearmsJump) &&
      !outcomes.every(rearmsJump)
    )
      focus = 'rearmsStroke';
    else if (forwardWaterDrop && outcomes.some(risesSafely))
      focus = 'risesSafely';
    else if (
      outcomes.some((outcome) => outcome.returnsWithinArea) &&
      outcomes.some(forwardSurvivalWitness)
    )
      focus = 'forwardSurvivalWitness';
    else if (
      outcomes.some(
        (outcome) =>
          viableNext(outcome) &&
          outcome.entersArea &&
          !outcome.returnsWithinArea,
      )
    )
      focus = 'entersArea';
    else if (
      outcomes.some((outcome) => outcome.blockedHeld || outcome.blockedNext) &&
      outcomes.some(avoidsBlockAndMoves) &&
      !outcomes.every(avoidsBlockAndMoves)
    )
      focus = 'avoidsBlockAndMoves';
    if (focus) {
      // Keep every option; remove competing progress numbers from a focused question.
      modelState.focus = focus;
      modelState.outcomes = Object.fromEntries(
        Object.entries(modelState.outcomes).map(([action, outcome]) => [
          action,
          {
            ...(focus === 'pipeProgress' && outcome.pipeProgress
              ? { pipeEntryFrames: outcome.pipeEntryFrames }
              : {}),
            ...(focus === 'revealsHiddenBlock' && outcome.revealsHiddenBlock
              ? { hiddenBlockReadyFrames: outcome.hiddenBlockReadyFrames }
              : {}),
            ...(focus === 'supportLanding' && outcome.supportLanding
              ? { supportLandingFrames: outcome.supportLandingFrames }
              : {}),
            [focus]:
              focus === 'safeRequiredRoute'
                ? safeRequiredRoute(outcome)
                : focus === 'climbingWitness'
                  ? climbingWitness(outcome)
                  : focus === 'runJumpWitness'
                    ? runJumpWitness(outcome)
                    : focus === 'springHeight'
                      ? springHeight(outcome)
                      : focus === 'towardMazeRoute'
                        ? towardMazeRoute(outcome)
                        : ['rearmsSpring', 'rearmsStroke'].includes(focus)
                          ? rearmsJump(outcome)
                          : focus === 'horizontalSurvivalWitness'
                            ? horizontalSurvivalWitness(outcome)
                            : focus === 'risesSafely'
                              ? risesSafely(outcome)
                              : focus === 'movingSurvivalWitness'
                                ? movingSurvivalWitness(outcome)
                                : focus === 'heldSurvivalWitness'
                                  ? heldSurvivalWitness(outcome)
                                  : focus === 'forwardSurvivalWitness'
                                    ? forwardSurvivalWitness(outcome)
                                    : focus === 'rearmedSurvivalWitness'
                                      ? rearmedSurvivalWitness(outcome)
                                      : focus === 'airborneSurvivalWitness'
                                        ? airborneSurvivalWitness(outcome)
                                        : focus === 'viableNext'
                                          ? viableNext(outcome)
                                          : focus === 'entersArea'
                                            ? outcome.entersArea &&
                                              !outcome.returnsWithinArea
                                            : focus === 'avoidsBlockAndMoves'
                                              ? avoidsBlockAndMoves(outcome)
                                              : outcome[focus],
          },
        ]),
      );
    }
  }
  return {
    state: modelState,
    questions: {
      move: {
        type: 'choice',
        instructions:
          focus === 'supportLanding'
            ? 'Choose supportLanding=true and prefer fewer supportLandingFrames. The same bounded path lands on an observed permanent narrow block and remains on that exact block with jump rearmed through two physical continuation intervals. The duration includes this first action and that verification. The bounded hypothesis search may miss routes: false is unknown, not unsafe. This does not prove pipe entry. Only this first action is executed; no planned sequence is applied.'
            : focus === 'revealsHiddenBlock'
              ? 'Choose revealsHiddenBlock=true and prefer fewer hiddenBlockReadyFrames. In the same bounded path, an observed hidden block becomes a permanent used block and Mario reaches a rearmed decision boundary with verified continuation. Hidden blocks are not standable before activation. This proves activation and readiness, not landing on the block or entering a pipe. Only this first action is executed; no continuation is applied.'
              : focus === 'pipeProgress'
                ? 'Choose pipeProgress=true and prefer fewer pipeEntryFrames: the shortest witnessed physical time to actual pipe entry, including this first action. A down action whose witness still needs later steering is not immediate entry. The bounded same-path preparation and down input reach a playable same-level destination farther ahead or in different loaded area data. This proves only that transition, not the entire route or victory. Only the next interval is executed; no planned sequence is applied.'
                : focus === 'retriesFailedMazeSequence'
                  ? 'Which action has retriesFailedMazeSequence=true? A native checkpoint in this sequence already failed. Advance toward the engine-controlled maze loopback shown in the held forecast so another sequence can be attempted. This does not restart the campaign or restore lives or time. Only the next interval is executed.'
                  : focus === 'revealsMazeCheckpoint'
                    ? 'Which action has revealsMazeCheckpoint=true? Advance toward a new, attributable native checkpoint result in the held forecast. The result may be failure and a maze reset: this is information gathering, not proof that the route succeeds. Only the next interval is executed.'
                    : focus
                      ? `Which action has ${focus}=true?`
                      : state.forecast
                        ? 'Prefer aliveNext=true, trap=false, avoidsKnownBlockage=true, and movesHeld=true. Prefer clearsLevel=true or entersArea=true without returnsWithinArea=true among equally safe actions. returnsWithinArea means a verified pipe return to an earlier point, not death or unknown safety. Then maximize forwardNext and forwardHeld. Only the next interval is executed; held outcomes are warnings, not commitments. Negative displacement is allowed.'
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

export function parseDecision(result, { official = false } = {}) {
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
    const values = Object.values(probabilities);
    const numeric = values.every(Number.isFinite);
    const total = numeric
      ? values.reduce((sum, value) => sum + value, 0)
      : Number.NaN;
    // Official responses round probabilities to hundredths. Accept only when
    // their rounding intervals contain a unit distribution; preserve raw values.
    const roundedUnitTotal =
      official &&
      numeric &&
      values.every(
        (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
      ) &&
      values.reduce((sum, value) => sum + Math.max(0, value - 0.005), 0) <=
        1 + 1e-9 &&
      values.reduce((sum, value) => sum + Math.min(1, value + 0.005), 0) >=
        1 - 1e-9;
    if (
      typeof probabilities !== 'object' ||
      Array.isArray(probabilities) ||
      Object.keys(probabilities).sort().join(',') !==
        Object.keys(ACTIONS).sort().join(',') ||
      Object.values(probabilities).some(
        (p) => !Number.isFinite(p) || p < 0 || p > 1,
      ) ||
      (Math.abs(total - 1) > 1e-5 && !roundedUnitTotal) ||
      (!official &&
        probabilities[move.choice] <
          Math.max(...Object.values(probabilities))) ||
      (move.confidence !== undefined &&
        (!Number.isFinite(move.confidence) ||
          move.confidence < 0 ||
          move.confidence > 1 ||
          (!official &&
            Math.abs(move.confidence - probabilities[move.choice]) > 1e-5)))
    ) {
      throw new Error(
        `Decision service returned an invalid action probability distribution (options=${values.length}, sum=${numeric ? total : 'non-numeric'}, selectedIsMaximum=${numeric && probabilities[move.choice] === Math.max(...values)}, confidenceType=${typeof move.confidence}).`,
      );
    }
  } else if (move.confidence !== undefined) {
    throw new Error(
      'Decision service returned confidence without an action distribution.',
    );
  }
  return {
    action: move.choice,
    jumpNeeded: jump.noul,
    confidence: official
      ? (move.confidence ?? null)
      : (probabilities?.[move.choice] ?? null),
    probabilities,
    dangerScore: null,
    ...(official &&
    probabilities &&
    probabilities[move.choice] < Math.max(...Object.values(probabilities))
      ? {
          responseWarning:
            'Official Jev Choice differs from the probability maximum; native Choice is preserved without replacement.',
        }
      : {}),
  };
}

export async function choose(
  state,
  {
    baseURL,
    runId,
    signal,
    backend = 'this-that',
    apiKey,
    model = DEFAULT_JEV_MODEL,
  },
) {
  if (!['this-that', 'jev-official'].includes(backend))
    throw new Error('Unknown decision backend.');
  const official = backend === 'jev-official';
  if (official && baseURL !== OFFICIAL_JEV_URL)
    throw new Error('Official Jev only uses https://api.typesafe.ai.');
  const started = performance.now();
  const request = decisionRequest(state);
  if (request.state.focus === 'runJumpWitness') {
    const { focus, outcomes } = request.state;
    request.state.outcomes = Object.fromEntries(
      Object.entries(outcomes).map(([action, outcome]) => [
        action,
        {
          result: outcome[focus]
            ? 'MEETS the required condition'
            : 'DOES NOT MEET the required condition',
        },
      ]),
    );
    request.questions.move.instructions =
      'Which action MEETS the required condition according to its verified result?';
  }
  const raw = official
    ? await officialRequest('/v1/systemone', {
        apiKey,
        signal,
        body: { model, ...request },
      })
    : await fetchJSON(`${loopbackURL(baseURL)}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-link-run-id': runId },
        body: JSON.stringify(request),
        signal,
      });
  if (
    !official &&
    (raw.engine !== 'this-that' || raw.model !== 'flock-io/this-that-model-1.2')
  )
    throw new Error(
      'Expected local this-that-model-1.2; refusing a different decision backend.',
    );
  if (
    official &&
    (typeof raw?.model !== 'string' ||
      !/^jev-(?:latest|preview|\d+\.\d+\.\d+)$/.test(raw.model) ||
      (!['jev-latest', 'jev-preview'].includes(model) && raw.model !== model))
  )
    throw new Error('Official Jev returned an unexpected model identity.');
  const decision = parseDecision(raw, { official });
  if (!decision.probabilities)
    throw new Error(
      'Decision model must return its actual action probability distribution.',
    );
  if (official && decision.confidence === null)
    throw new Error('Official Jev must return its reported Choice confidence.');
  return {
    ...decision,
    backend,
    latencyMs: performance.now() - started,
    raw: official
      ? {
          engine: backend,
          model: raw.model,
          answers: raw.answers,
          usage: raw.usage,
        }
      : raw,
    modelInput: request.state,
    modelQuestions: request.questions,
    inputStats: {
      fullStateChars: JSON.stringify(state).length,
      sentStateChars: JSON.stringify(request.state).length,
      inputTokens: raw.usage?.input_tokens ?? null,
    },
  };
}

export async function checkJev(
  baseURL,
  { backend = 'this-that', apiKey, model = DEFAULT_JEV_MODEL } = {},
) {
  if (backend === 'jev-official') {
    if (baseURL !== OFFICIAL_JEV_URL)
      throw new Error('Official Jev only uses https://api.typesafe.ai.');
    const result = await officialRequest('/v1/models', { apiKey });
    if (
      !Array.isArray(result?.models) ||
      result.models.length === 0 ||
      result.models.some((entry) => typeof entry?.name !== 'string')
    )
      throw new Error('Official Jev returned an invalid model list.');
    return {
      ready: true,
      engine: backend,
      model,
      device: 'TypeSafe API',
      check: 'authenticated model list; inference is verified on each decision',
    };
  }
  if (backend !== 'this-that') throw new Error('Unknown decision backend.');
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
