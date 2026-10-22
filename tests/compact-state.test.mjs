import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactState } from '../compact-state.mjs';
import { ACTIONS, decisionRequest } from '../policy.mjs';
import { Telemetry } from '../telemetry.mjs';
import { ramFixture } from './fixtures.mjs';

const state = () => new Telemetry(16).sample(ramFixture(), 0);
const step = (x, toX, changes = {}) => ({
  x,
  toX,
  y: 192,
  toY: 192,
  action: 'right_run',
  headBump: false,
  landed: false,
  heldJump: false,
  ...changes,
});
const episode = (endX, trace, reason = 'no_forward_progress') => ({
  runId: 'unneeded-uuid',
  outcome: reason === 'death' ? 'dead' : 'restarted',
  endX,
  failureReason: reason,
  trace,
});

test('compact state preserves timing, controls and unknown geometry without mutating telemetry', () => {
  const full = state();
  full.terrain.observedX = null;
  full.player.jumpPhase = 'falling';
  full.player.verticalSpeed = 3;
  full.recent_control.headBump = true;
  const original = structuredClone(full);
  const compact = compactState(full);
  assert.equal(compact.frames, 16);
  assert.equal(compact.player.phase, 'falling');
  assert.equal(compact.player.vy, 3);
  assert.equal(compact.control.headBump, true);
  assert.equal(compact.terrain.observedX, null);
  assert.equal(compact.player.canJump, full.recent_control.jumpReady);
  assert.deepEqual(full, original);
  assert.equal(compact.player.score, undefined);
  assert.throws(() => compactState({}), /complete Mario telemetry/);
});

test('all current surfaces/enemies and unique grounded geometry survive compression', () => {
  const full = state();
  full.terrain.lastGroundedPreview = {
    frame: 0,
    observedX: [0, 200],
    possibleGaps: [{ startX: 180, endX: 196 }],
    surfaces: [
      ...full.terrain.surfaces,
      { startX: 0, endX: 16, topY: 144, bottomY: 160 },
    ],
  };
  full.episode.frame = 16;
  full.hazard.enemies = Array.from({ length: 5 }, (_, i) => ({
    name: `enemy_${i}`,
    dx: i * 20,
    dy: -8,
    projectedDx: null,
    contactInFrames: null,
  }));
  const compact = compactState(full);
  assert.equal(compact.hazard.enemies.length, 5);
  assert.equal(compact.hazard.enemies[0].contactInFrames, null);
  assert.equal(compact.terrain.solids.length, full.terrain.surfaces.length);
  assert.deepEqual(compact.terrain.groundedPreview.extraSolids, [
    [0, 144, 16, 160],
  ]);
  assert.deepEqual(compact.terrain.groundedPreview.gaps, [[180, 196]]);
  assert.equal(compact.terrain.groundedPreview.ageFrames, 16);
});

test('select one nearest failure and one progress excerpt, preserving failures and partial outcomes', () => {
  const full = state();
  full.player.x = 420;
  full.experience = {
    nearbyEpisodes: [
      episode(680, [step(630, 680)], 'death'),
      episode(
        434,
        Array.from({ length: 12 }, () => step(434, 434)),
      ),
      episode(
        495,
        [
          step(424, 442, {
            action: 'right_run_jump',
            toY: 122,
            heldJump: true,
          }),
          step(442, 467),
        ],
        null,
      ),
    ],
  };
  const compact = compactState(full);
  assert.equal(compact.memory.length, 2);
  assert.equal(compact.memory[0].episodeEndX, 434);
  assert.equal(compact.memory[0].steps.length, 1);
  assert.equal(compact.memory[0].steps[0].count, 12);
  assert.equal(compact.memory[0].endingStep.count, 1);
  assert.equal(compact.memory[1].outcome, 'restarted');
  assert.equal(compact.memory[0].runId, undefined);
  assert.ok(
    JSON.stringify(compact).length < JSON.stringify(full).length * 0.55,
  );
});

test('head bumps, landings and release transitions are never merged away', () => {
  const full = state();
  full.player.x = 250;
  full.experience = {
    nearbyEpisodes: [
      episode(
        312,
        [
          step(240, 264, {
            action: 'right_run_jump',
            headBump: true,
            toY: 155,
            heldJump: true,
          }),
          step(264, 288, {
            action: 'right_run_jump',
            y: 155,
            toY: 188,
            heldJump: true,
          }),
          step(288, 312, { y: 188, landed: true }),
        ],
        'death',
      ),
    ],
  };
  const compact = compactState(full);
  assert.equal(compact.memory[0].steps[0].headBump, true);
  assert.equal(compact.memory[0].steps[2].landed, true);
  assert.equal(compact.memory[0].steps[2].action, 'right_run');
});

test('long excerpts are bounded and marked as incomplete rather than inventing a full path', () => {
  const full = state();
  full.player.x = 160;
  full.experience = {
    nearbyEpisodes: [
      episode(
        400,
        Array.from({ length: 12 }, (_, i) =>
          step(i * 32, i * 32 + 32, {
            action: i % 2 ? 'right_run_jump' : 'right_run',
          }),
        ),
        'death',
      ),
    ],
  };
  const request = decisionRequest(full);
  assert.equal(request.state.game.memory[0].steps.length, 4);
  assert.equal(request.state.game.memory[0].omittedSteps, 8);
  assert.equal(Object.keys(request.questions).length, 2);
  assert.equal(request.assets, undefined);
});

test('collision forecasts retain their meaning across the held-action horizon', () => {
  const full = state();
  full.hazard.imminentCollision = true;
  full.hazard.enemies = [
    { name: 'goomba', dx: 36, dy: -8, projectedDx: -22, contactInFrames: 5.5 },
  ];
  const request = decisionRequest(full);
  assert.deepEqual(request.state.game.hazard, {
    imminentCollision: true,
    enemies: [
      {
        type: 'goomba',
        dx: 36,
        dy: -8,
        projectedDx: -22,
        contactInFrames: 5.5,
      },
    ],
  });
  assert.equal(request.state.game.frames, 16);
  assert.match(request.state.goal, /crossing zero is not safety/);
  assert.match(request.questions.move.instructions, /survival over progress/);
});

test('memory at a segment boundary favors the step starting at the current position', () => {
  const full = state();
  full.experience = {
    nearbyEpisodes: [
      episode(
        495,
        [
          step(240, 288),
          step(288, 312, {
            action: 'right_run_jump',
            toY: 176,
            headBump: true,
          }),
          step(312, 333, { y: 176, landed: true }),
          step(333, 424),
          step(424, 442, { action: 'right_run_jump', toY: 122 }),
        ],
        null,
      ),
    ],
  };
  full.player.x = 312;
  const excerpt = compactState(full).memory[0];
  assert.equal(excerpt.steps[0].headBump, true);
  assert.equal(excerpt.steps.at(-1).from[0], 424);
});

test('excerpts retain the actual episode-ending action even when it is far away', () => {
  const full = state();
  full.player.x = 288;
  const ending = step(632, 680, { y: 144, toY: 192 });
  full.experience = {
    nearbyEpisodes: [
      episode(
        680,
        [
          step(240, 288),
          step(288, 312, {
            action: 'right_run_jump',
            toY: 176,
            headBump: true,
          }),
          step(312, 333, { y: 176, landed: true }),
          step(333, 424),
          step(424, 442, { action: 'right_run_jump', toY: 122 }),
          ending,
        ],
        'death',
      ),
    ],
  };
  const excerpt = compactState(full).memory[0];
  assert.equal(excerpt.steps.length, 4);
  assert.equal(excerpt.episodeEndX, 680);
  assert.deepEqual(excerpt.endingStep, {
    action: 'right_run',
    from: [632, 144],
    to: [680, 192],
    count: 1,
  });
  assert.equal(excerpt.outcome, 'dead');
});

test('each option includes its own factual forecast without filtering dangerous choices', () => {
  const full = state();
  full.forecast = {
    frames: 16,
    heldFor: 48,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 192, 'grounded'],
          held: [0, 192, 'grounded'],
          jumpReadyNext: !action.includes('jump'),
        },
      ]),
    ),
  };
  full.forecast.moves.right_run = {
    next: [12, 192, 'dead'],
    held: [12, 192, 'dead'],
    jumpReadyNext: false,
  };
  full.forecast.moves.right_run_jump = {
    next: [7, 137, 'rising'],
    held: [65, 184, 'falling'],
    jumpReadyNext: false,
  };
  full.forecast.moves.right_jump = {
    next: [28, 172, 'falling'],
    held: [39, 192, 'dead'],
    noSurvivingFollowup: true,
    jumpReadyNext: false,
  };
  const request = decisionRequest(full);
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  assert.match(
    request.questions.move.criteria.right_run,
    /12 pixels forward, y=192, dead/,
  );
  assert.match(
    request.questions.move.criteria.right_run_jump,
    /7 pixels forward, y=137, rising/,
  );
  assert.equal(request.state.game.forecast, undefined);
  assert.match(request.questions.move.criteria.right_jump, /TRAP/);
});
