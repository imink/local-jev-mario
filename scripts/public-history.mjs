import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ACTIONS } from '../browser/core.mjs';

export const AUDIT = Object.freeze({
  version: 1,
  romSHA256: 'ec299b990e8bfee8ba46e3f61d63b2e1ae5b8a2e431de84e2e4bbd692dc53586',
  sourceSHA256:
    '04b0f6fea7baf613592b5e13c45568c621cb37fc2a03eea52c09ccd1611cdebc',
  pixelSHA256:
    '2bb29937f33305568c9daa9a43bb9d781b2ac598a0ebadaf901b9bf008932f95',
  totalDecisions: 6275,
  totalFrames: 113645,
  totalAutomatic: 486,
  totalEvents: 6761,
});

// Only gameplay field names used by the recorded, reviewed input schema.
const inputKeys = new Set(
  `
ageFrames airborneSurvivalWitness aliveHeld aliveNext alternativeFloorYs alternativeFloors
area areaChanged avoidsBlockAndMoves avoidsKnownBlockage blockedHeld blockedNext blockedPositions
campaign canJump checkedInSequence checkpointPage checkpoints clearsLevel climbFloors climbLanding
climbingWitness completedLevels contactInFrames continuationFrames control correctFloorYs
correctInSequence currentLevel distance down dx dy endX enemies entersArea extraSolids failedFloorYs
firstActionFrames focus forwardHeld forwardNext forwardSurvivalWitness frames game gaps gateX goal
groundedHeld groundedMazeReset groundedPreview hazard headBump height heldA heldForFrames heldY
hiddenBlockReadyFrames hiddenBlocks higherLandingY horizontalSurvivalWitness imminentCollision jump
jumpReadyNext landed last lastResult left left_jump mazeCheckpointFailedNext mazeConnectedLanding
mazeFeedback mazeLanding mazeRoute memory missingReadinessWitness movesBodyLength movesHeld
movingSurvivalWitness narrowSupportBeamWidth narrowSupportLookaheadFrames
narrowSupportPreparationLookaheadFrames narrowSupportSamplingFrames narrowSupportValidationFrames
narrowSupports navigation nextY noop observedLoopCount observedX obstacle ordinal outcomes page phase
pipeAutomaticFrameLimit pipeEntryFrames pipeEntryLookaheadFrames pipeProgress pipeTops player
predictionScope preservesLevelSequence projectedDx reachesObstacleHeight readinessLookaheadFrames
readinessSamplingFrames ready rearmedSurvivalWitness rearmsSpring rearmsStroke repeatsMaze
resetCanReflectEarlierFailure result retriesFailedMazeSequence revealsHiddenBlock revealsMazeCheckpoint
right right_jump right_run right_run_jump risesSafely runJumpLanding runJumpTargetX solids springHeight
stage stalledFrames startX startsSwimStroke supportBlocks supportLanding supportLandingFrames
survivesWithOneReplan swimming terrain topY totalLevels towardMazeRoute trap type viableNext vx vy world x y
`
    .trim()
    .split(/\s+/),
);
const playerKeys = `
x y height cameraX state mode task controllable automatic area areaPointer areaDataAddress grounded
swimming jumpAvailable verticalSpeed jumpPhase power world stage lives time score dead gameOver
levelClear clear`
  .trim()
  .split(/\s+/);

export function publicText(value) {
  assert.equal(typeof value, 'string');
  assert(value.length <= 2048, 'Public text too long.');
  assert(
    !/https?:|[\\/](?:Users|home|tmp|private|var)[\\/]|[A-Za-z]:\\|@|authorization|bearer|api[_ -]?key|password|secret|token|cookie|gh[pousr]_|github_pat_/i.test(
      value,
    ),
    'Sensitive content in public gameplay text.',
  );
  return value;
}

export function publicInput(value, depth = 0) {
  assert(depth <= 20, 'Public input too deep.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    assert(Number.isFinite(value));
    return value;
  }
  if (typeof value === 'string') return publicText(value);
  if (Array.isArray(value)) {
    assert(value.length <= 256);
    return value.map((item) => publicInput(item, depth + 1));
  }
  assert(value && Object.getPrototypeOf(value) === Object.prototype);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    assert(inputKeys.has(key), 'Unapproved public input field.');
    if (key === 'memory') assert.deepEqual(item, [], 'Memory must be empty.');
    result[key] = publicInput(item, depth + 1);
  }
  return result;
}

function probability(value) {
  assert(typeof value === 'number' && value >= 0 && value <= 1);
  return value;
}

function publicPlayer(player) {
  const result = {};
  for (const key of playerKeys) {
    if (Object.hasOwn(player, key)) result[key] = publicInput(player[key]);
  }
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.clear, 'boolean');
  return result;
}

export function publicDecision(decision, request) {
  const move = decision.raw?.answers?.move;
  assert.equal(move?.type, 'choice');
  assert(Object.hasOwn(ACTIONS, move.choice));
  assert.equal(move.choice, decision.action);
  const answers = { move: { type: 'choice', choice: move.choice } };
  if (move.confidence != null)
    answers.move.confidence = probability(move.confidence);
  if (move.probabilities != null) {
    answers.move.probabilities = {};
    for (const [action, value] of Object.entries(move.probabilities)) {
      assert(Object.hasOwn(ACTIONS, action));
      answers.move.probabilities[action] = probability(value);
    }
  }
  const jump = decision.raw.answers.jump_needed;
  if (jump) {
    assert.equal(jump.type, 'noul');
    answers.jump_needed = { type: 'noul', noul: probability(jump.noul) };
  }
  const questions = {};
  for (const name of ['move', 'jump_needed']) {
    const q = decision.modelQuestions[name];
    assert.equal(q.type, name === 'move' ? 'choice' : 'noul');
    questions[name] = {
      type: q.type,
      instructions: publicText(q.instructions),
    };
    if (name === 'move') {
      questions[name].criteria = {};
      for (const [action, criterion] of Object.entries(q.criteria)) {
        assert(Object.hasOwn(ACTIONS, action));
        assert.equal(criterion, action);
        questions[name].criteria[action] = action;
      }
    }
  }
  assert(Number.isInteger(request.state.episode.frame));
  assert(Number.isFinite(decision.latencyMs) && decision.latencyMs >= 0);
  return {
    inputFrame: request.state.episode.frame,
    input: publicInput(decision.modelInput),
    questions,
    answers,
    latencyMs: decision.latencyMs,
  };
}

export async function exportHistory(logPath, directory) {
  await mkdir(directory, { recursive: true });
  const hash = createHash('sha256');
  const stream = createReadStream(logPath);
  stream.on('data', (bytes) => hash.update(bytes));
  let request;
  let choice;
  let count = 0;
  let frame = 0;
  let automaticCount = 0;
  let start;
  let batch = [];
  const chunks = [];
  async function flush() {
    if (!batch.length) return;
    const bytes = Buffer.from(JSON.stringify(batch));
    const file = `events-${String(chunks.length).padStart(3, '0')}.json`;
    assert(bytes.length < 2 * 1024 * 1024, 'Public chunk too large.');
    await writeFile(join(directory, file), bytes);
    chunks.push({
      file,
      events: batch.length,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    batch = [];
  }
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    assert(line.length <= 2 * 1024 * 1024);
    const e = JSON.parse(line);
    if (!start) {
      assert.equal(e.kind, 'start');
      assert.equal(e.romSHA256, AUDIT.romSHA256);
      assert.equal(e.experienceEnabled, false);
      start = e;
    }
    assert.equal(e.runId, start.runId);
    if (e.kind === 'request') request = e;
    if (e.kind === 'choice') choice = e;
    if (!['transition', 'automatic-transition'].includes(e.kind)) continue;
    const automatic = e.kind === 'automatic-transition';
    assert(Number.isInteger(e.frames) && e.frames > 0 && e.frames <= 60);
    assert.equal(e.state.episode.frame, frame + e.frames);
    assert(Object.hasOwn(ACTIONS, e.action));
    const event = {
      automatic,
      action: e.action,
      frames: e.frames,
      frame: e.state.episode.frame,
      player: publicPlayer(e.state.player),
      completedLevels: publicInput(e.state.campaign.completedLevels),
    };
    if (automatic) {
      assert.equal(e.action, 'noop');
      automaticCount++;
    } else {
      assert.equal(e.index, count);
      assert.equal(request?.index, count);
      assert.equal(choice?.index, count);
      assert.equal(choice.decision.action, e.action);
      assert.equal(request.state.episode.frame, frame);
      event.index = count++;
      event.history = publicDecision(choice.decision, request);
      choice = null;
    }
    frame = event.frame;
    batch.push(event);
    if (batch.length === 128) await flush();
  }
  await flush();
  assert.equal(hash.digest('hex'), AUDIT.sourceSHA256);
  assert.equal(count, AUDIT.totalDecisions);
  assert.equal(frame, AUDIT.totalFrames);
  assert.equal(automaticCount, AUDIT.totalAutomatic);
  const manifest = {
    ...AUDIT,
    chunks,
    provenance: [
      'Recorded official Jev Choices, not a new AI run or internal reasoning.',
      'All 32 stages in order. No cross-run memory. Natural life changes preserved.',
      'Campaign included maintenance, policy changes and 24 process recoveries.',
      'Decision index 3944: original live snapshot was lost after a debugging failure; deterministic reconstruction is not an original-live byte comparison.',
      'Failed/cancelled requests, headers, account data and private runtime files are not published. Only executed decisions are played.',
      'Terminal image is the native victory trigger, not the later ending sequence.',
    ],
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
