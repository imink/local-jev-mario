import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactState } from '../compact-state.mjs';
import { ACTIONS, decisionRequest } from '../policy.mjs';
import { Telemetry } from '../telemetry.mjs';
import { ramFixture } from './fixtures.mjs';

const state = () => new Telemetry(16).sample(ramFixture(), 0);

test('hidden-block readiness preserves all choices and does not claim pipe entry', () => {
  const full = state();
  full.navigation.observedLoopCount = 1;
  full.episode.stalledFrames = 200;
  full.terrain.hiddenBlocks = [{ x: 64, y: 144 }];
  full.forecast = {
    frames: 16,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [20, 180, 'rising'],
          held: [80, 208, 'grounded'],
          jumpReadyNext: false,
          survivesWithOneReplan: true,
          revealsHiddenBlock: action === 'jump' || action === 'left_jump',
          hiddenBlockReadyFrames: 32,
          noSurvivingFollowup: action === 'left_jump',
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'revealsHiddenBlock');
  assert.deepEqual(request.state.game.terrain.hiddenBlocks, [[64, 144]]);
  assert.equal(request.state.outcomes.jump.revealsHiddenBlock, true);
  assert.equal(request.state.outcomes.left_jump.revealsHiddenBlock, false);
  assert.equal(request.state.outcomes.right.revealsHiddenBlock, false);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
  assert.deepEqual(request.state.game.memory, []);
  assert.match(
    request.questions.move.instructions,
    /not landing.*or entering a pipe/,
  );
  full.navigation.runJumpTargetX = 64;
  full.navigation.climbFloors = [{ startX: 64, endX: 80, topY: 144 }];
  for (const [action, move] of Object.entries(full.forecast.moves)) {
    move.runJumpLanding = action === 'right_run_jump';
    move.climbLanding = action === 'right_jump';
  }
  assert.equal(decisionRequest(full).state.focus, 'revealsHiddenBlock');
  full.forecast.moves.right.pipeProgress = true;
  full.forecast.moves.right.pipeEntryFrames = 16;
  assert.equal(decisionRequest(full).state.focus, 'pipeProgress');
  full.forecast.moves.jump.hiddenBlockReadyFrames = undefined;
  assert.throws(() => decisionRequest(full), /hidden block readiness/);
});

test('stable narrow-support evidence precedes stale geometry but not native pipe progress', () => {
  const full = state();
  full.navigation.observedLoopCount = 1;
  full.navigation.narrowSupports = [{ startX: 64, endX: 80, topY: 144 }];
  full.navigation.runJumpTargetX = 64;
  full.forecast = {
    frames: 8,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 160, 'falling'],
          held: [0, 192, 'grounded'],
          jumpReadyNext: false,
          survivesWithOneReplan: true,
          supportLanding: action === 'noop',
          ...(action === 'noop' ? { supportLandingFrames: 80 } : {}),
          runJumpLanding: action === 'right_run_jump',
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'supportLanding');
  assert.equal(request.state.outcomes.noop.supportLandingFrames, 80);
  assert.equal(request.state.outcomes.right.supportLanding, false);
  assert.match(request.questions.move.instructions, /false is unknown/);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
  assert.deepEqual(request.state.game.memory, []);
  full.forecast.moves.down.pipeProgress = true;
  full.forecast.moves.down.pipeEntryFrames = 24;
  assert.equal(decisionRequest(full).state.focus, 'pipeProgress');
  full.forecast.moves.noop.supportLandingFrames = undefined;
  assert.throws(() => decisionRequest(full), /narrow support landing/);
});

test('known backward pipe entry cannot override safe forward evidence or another useful entry', () => {
  const full = state();
  full.forecast = {
    frames: 16,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [action === 'right' ? 24 : 0, full.player.y, 'grounded'],
          held: [action === 'right' ? 48 : 0, full.player.y, 'grounded'],
          jumpReadyNext: true,
          survivesWithOneReplan: true,
          entersArea: action === 'down',
          ...(action === 'down'
            ? { areaDestination: [1, 1], returnsWithinArea: true }
            : {}),
        },
      ]),
    ),
  };
  let request = decisionRequest(full);
  assert.equal(request.state.focus, 'forwardSurvivalWitness');
  assert.equal(request.state.outcomes.right.forwardSurvivalWitness, true);
  assert.equal(request.state.outcomes.down.forwardSurvivalWitness, false);
  const right = full.forecast.moves.right;
  right.next[0] = 0;
  right.held[0] = 0;
  right.entersArea = true;
  right.areaDestination = [1, 1];
  request = decisionRequest(full);
  assert.equal(request.state.focus, 'entersArea');
  assert.equal(request.state.outcomes.right.entersArea, true);
  assert.equal(request.state.outcomes.down.entersArea, false);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
});

test('witnessed pipe progress after a loop precedes geometry without hiding unsafe first actions', () => {
  const full = state();
  full.navigation.observedLoopCount = 1;
  full.navigation.climbFloors = [{ startX: 64, endX: 96, topY: 160 }];
  full.forecast = {
    frames: 16,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [16, 160, 'grounded'],
          held: [48, 160, 'grounded'],
          jumpReadyNext: true,
          survivesWithOneReplan: true,
          climbLanding: action === 'right_run',
          pipeProgress: ['right_jump', 'left'].includes(action),
          pipeEntryFrames: 32,
          noSurvivingFollowup: action === 'left',
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'pipeProgress');
  assert.equal(request.state.outcomes.right_jump.pipeProgress, true);
  assert.equal(request.state.outcomes.right_jump.pipeEntryFrames, 32);
  assert.equal(request.state.outcomes.left.pipeProgress, false);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
  assert.deepEqual(request.state.game.memory, []);
  full.navigation.observedLoopCount = undefined;
  assert.equal(decisionRequest(full).state.focus, 'climbingWitness');
});
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
  assert.deepEqual(compact.campaign, full.campaign);
  assert.match(compact.campaign.goal, /32 levels.*8-4/);
  assert.equal(compact.player.world, 1);
  assert.equal(compact.player.stage, 1);
  assert.equal(compact.player.phase, 'falling');
  assert.equal(compact.player.vy, 3);
  assert.equal(compact.control.headBump, true);
  assert.equal(compact.terrain.observedX, null);
  assert.equal(compact.player.canJump, full.recent_control.jumpReady);
  assert.equal(compact.player.swimming, false);
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
  assert.match(
    request.questions.move.instructions,
    /crossing zero is not safety/,
  );
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

test('native outcome table preserves forecast facts without filtering or selecting actions', () => {
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
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.right_run = {
    next: [12, 192, 'dead'],
    held: [12, 192, 'dead'],
    jumpReadyNext: false,
    survivesWithOneReplan: false,
  };
  full.forecast.moves.right_run_jump = {
    next: [7, 137, 'rising'],
    held: [65, 184, 'falling'],
    jumpReadyNext: false,
    survivesWithOneReplan: true,
  };
  full.forecast.moves.right_jump = {
    next: [28, 172, 'falling'],
    held: [39, 192, 'dead'],
    noSurvivingFollowup: true,
    jumpReadyNext: false,
    survivesWithOneReplan: true,
  };
  full.forecast.moves.down.entersArea = true;
  full.forecast.moves.down.areaDestination = [1, 1];
  const danger = decisionRequest(full);
  assert.equal(danger.state.focus, 'movingSurvivalWitness');
  assert.deepEqual(danger.state.outcomes.right_run, {
    movingSurvivalWitness: false,
  });
  assert.deepEqual(danger.state.outcomes.right_jump, {
    movingSurvivalWitness: false,
  });
  assert.deepEqual(danger.state.outcomes.right_run_jump, {
    movingSurvivalWitness: true,
  });
  assert.deepEqual(
    Object.keys(danger.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  assert.equal(full.forecast.moves.right_run.next[2], 'dead');
  full.forecast.moves.right_run.next[2] = 'grounded';
  full.forecast.moves.right_run.held[2] = 'grounded';
  full.forecast.moves.right_jump.held[2] = 'grounded';
  full.forecast.moves.right_jump.noSurvivingFollowup = false;
  full.forecast.moves.right_run.survivesWithOneReplan = true;
  full.forecast.moves.right_jump.survivesWithOneReplan = true;
  full.forecast.moves.down.entersArea = false;
  const request = decisionRequest(full);
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  assert.deepEqual(Object.keys(request.state.outcomes), Object.keys(ACTIONS));
  assert.deepEqual(request.state.outcomes.right_run, {
    aliveNext: true,
    aliveHeld: true,
    groundedHeld: true,
    trap: false,
    survivesWithOneReplan: true,
    forwardNext: 12,
    forwardHeld: 12,
    jumpReadyNext: false,
    clearsLevel: false,
    entersArea: false,
    preservesLevelSequence: true,
    nextY: 192,
    heldY: 192,
    blockedHeld: false,
    blockedNext: false,
    avoidsKnownBlockage: true,
    movesHeld: true,
    movesBodyLength: true,
  });
  assert.deepEqual(request.state.outcomes.right_run_jump, {
    aliveNext: true,
    aliveHeld: true,
    groundedHeld: false,
    trap: false,
    survivesWithOneReplan: true,
    forwardNext: 7,
    forwardHeld: 65,
    jumpReadyNext: false,
    clearsLevel: false,
    entersArea: false,
    preservesLevelSequence: true,
    nextY: 137,
    heldY: 184,
    blockedHeld: false,
    blockedNext: false,
    avoidsKnownBlockage: true,
    movesHeld: true,
    movesBodyLength: true,
  });
  assert.equal(request.state.outcomes.down.entersArea, false);
  assert.equal(request.state.game.forecast, undefined);
  assert.equal(request.state.outcomes.right_jump.trap, false);
  assert.match(request.questions.move.instructions, /maximize forwardNext/);
  assert.equal(request.questions.move.criteria.right_run, 'right_run');
  full.forecast.moves.down.entersArea = true;
  const entry = decisionRequest(full);
  assert.equal(entry.state.focus, 'entersArea');
  assert.deepEqual(entry.state.outcomes.down, { entersArea: true });
  assert.deepEqual(entry.state.outcomes.right_run, { entersArea: false });
  assert.deepEqual(
    Object.keys(entry.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.forecast.moves.down.areaDestination = [2, 1];
  const warp = decisionRequest(full);
  assert.equal(warp.state.focus, 'safeRequiredRoute');
  assert.deepEqual(warp.state.outcomes.down, { safeRequiredRoute: false });
  assert.deepEqual(warp.state.outcomes.right_run, { safeRequiredRoute: true });
  assert.deepEqual(
    Object.keys(warp.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.player.stage = 4;
  assert.equal(decisionRequest(full).state.focus, 'entersArea');
  full.player.stage = 1;
  full.forecast.moves.down.areaDestination = undefined;
  assert.throws(() => decisionRequest(full), /pipe destination/);
  full.forecast.moves.down.entersArea = false;
  full.navigation.blockedPositions = [
    { x: full.player.x + 65, y: 184 },
    { x: full.player.x + 7, y: 137 },
  ];
  const blocked = decisionRequest(full);
  assert.equal(blocked.state.focus, 'avoidsBlockAndMoves');
  assert.deepEqual(blocked.state.outcomes.right_run_jump, {
    avoidsBlockAndMoves: false,
  });
  assert.equal(Object.keys(blocked.questions.move.criteria).length, 9);
  assert.deepEqual(blocked.state.outcomes.left, { avoidsBlockAndMoves: true });
  full.navigation.blockedPositions[0].x++;
  full.navigation.blockedPositions[1].x++;
  assert.deepEqual(decisionRequest(full).state.outcomes.right_run_jump, {
    avoidsBlockAndMoves: false,
  });
  full.navigation.blockedPositions[0].x++;
  full.navigation.blockedPositions[1].x++;
  assert.equal(
    decisionRequest(full).state.outcomes.right_run_jump.blockedHeld,
    false,
  );
  full.navigation.blockedPositions = [];
  full.forecast.moves.right_run.held[2] = 'dead';
  const held = decisionRequest(full);
  assert.equal(held.state.focus, undefined);
  assert.equal(held.state.outcomes.right_run.aliveHeld, false);
  assert.equal(held.state.outcomes.right_run_jump.aliveHeld, true);
  assert.deepEqual(Object.keys(held.state.outcomes), Object.keys(ACTIONS));
  full.forecast.moves.right_run.survivesWithOneReplan = false;
  const unwitnessed = decisionRequest(full);
  assert.equal(unwitnessed.state.focus, 'movingSurvivalWitness');
  assert.deepEqual(unwitnessed.state.outcomes.right_run, {
    movingSurvivalWitness: false,
  });
  assert.equal(full.forecast.moves.right_run.noSurvivingFollowup, undefined);
  full.forecast.moves.noop.survivesWithOneReplan = undefined;
  assert.throws(() => decisionRequest(full), /Missing continuation survival/);
});

test('safety focus does not invent an escape or force a stationary long hold', () => {
  const full = state();
  full.forecast = {
    frames: 16,
    heldFor: 60,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, full.player.y, 'grounded'],
          held: [0, full.player.y, 'dead'],
          jumpReadyNext: false,
          noSurvivingFollowup: true,
          survivesWithOneReplan: false,
        },
      ]),
    ),
  };
  full.forecast.moves.left.next[2] = 'dead';
  const immediate = decisionRequest(full);
  assert.equal(immediate.state.focus, 'aliveNext');
  assert.deepEqual(immediate.state.outcomes.left, { aliveNext: false });
  assert.deepEqual(immediate.state.outcomes.right, { aliveNext: true });
  assert.deepEqual(Object.keys(immediate.state.outcomes), Object.keys(ACTIONS));

  for (const move of Object.values(full.forecast.moves)) move.next[2] = 'dead';
  const doomed = decisionRequest(full);
  assert.equal(doomed.state.focus, undefined);
  assert.ok(
    Object.values(doomed.state.outcomes).every(
      (outcome) => !outcome.aliveNext && !outcome.aliveHeld && outcome.trap,
    ),
  );
  assert.deepEqual(
    Object.keys(doomed.questions.move.criteria),
    Object.keys(ACTIONS),
  );

  for (const move of Object.values(full.forecast.moves)) {
    move.next[2] = 'grounded';
    move.noSurvivingFollowup = false;
  }
  full.forecast.moves.noop.held[2] = 'grounded';
  full.forecast.moves.noop.survivesWithOneReplan = true;
  const stationary = decisionRequest(full);
  assert.equal(stationary.state.focus, undefined);
  assert.equal(stationary.state.outcomes.noop.aliveHeld, true);
  assert.equal(stationary.state.outcomes.noop.movesHeld, false);
});

test('a newly rearmed landing remains useful below the body-length movement threshold', () => {
  const full = state();
  full.player.y = 185;
  full.player.grounded = false;
  full.player.jumpPhase = 'falling';
  full.recent_control.jumpReady = false;
  full.forecast = {
    frames: 4,
    heldFor: 60,
    continuationFrames: 16,
    readyStateLookaheadFrames: 52,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [6, 192, 'falling'],
          held: [60, 274, 'dead'],
          jumpReadyNext: false,
          survivesWithOneReplan: false,
        },
      ]),
    ),
  };
  full.forecast.moves.left = {
    next: [4, 192, 'grounded'],
    held: [-9, 192, 'grounded'],
    jumpReadyNext: true,
    survivesWithOneReplan: true,
  };
  for (const frames of [4, 8, 16]) {
    full.forecast.frames = frames;
    full.forecast.readyStateLookaheadFrames = frames + 48;
    const original = structuredClone(full);
    const request = decisionRequest(full);
    assert.equal(request.state.focus, 'rearmedSurvivalWitness');
    for (const action of Object.keys(ACTIONS))
      assert.deepEqual(request.state.outcomes[action], {
        rearmedSurvivalWitness: action === 'left',
      });
    assert.deepEqual(
      Object.keys(request.questions.move.criteria),
      Object.keys(ACTIONS),
    );
    assert.deepEqual(full, original);
  }

  full.recent_control.jumpReady = true;
  assert.equal(decisionRequest(full).state.focus, 'airborneSurvivalWitness');
  full.player.grounded = true;
  assert.equal(decisionRequest(full).state.focus, undefined);
  full.player.grounded = false;
  full.recent_control.jumpReady = false;
  full.forecast.moves.left.noSurvivingFollowup = true;
  const trapped = decisionRequest(full);
  assert.equal(trapped.state.focus, 'viableNext');
  assert.deepEqual(trapped.state.outcomes.left, { viableNext: false });
});

test('a short rearmed landing does not displace an available moving survival witness', () => {
  const full = state();
  full.player.y = 100;
  full.player.grounded = false;
  full.player.jumpPhase = 'falling';
  full.recent_control.jumpReady = false;
  full.forecast = {
    frames: 16,
    heldFor: 60,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [12, 112, 'apex'],
          held: [73, 276, 'dead'],
          jumpReadyNext: false,
          survivesWithOneReplan: false,
        },
      ]),
    ),
  };
  full.forecast.moves.noop = {
    next: [0, 112, 'grounded'],
    held: [0, 112, 'dead'],
    jumpReadyNext: true,
    survivesWithOneReplan: true,
  };
  for (const action of ['left', 'left_jump'])
    full.forecast.moves[action] = {
      next: [-9, 112, 'grounded'],
      held: [-83, 113, 'falling'],
      jumpReadyNext: action === 'left',
      survivesWithOneReplan: true,
    };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'movingSurvivalWitness');
  for (const action of Object.keys(ACTIONS))
    assert.deepEqual(request.state.outcomes[action], {
      movingSurvivalWitness: ['left', 'left_jump'].includes(action),
    });
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
});

test('fatal held displacement does not outrank a newly rearmed short landing', () => {
  const full = state();
  full.player.y = 100;
  full.recent_control.jumpReady = false;
  full.forecast = {
    frames: 4,
    heldFor: 60,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 100, 'dead'],
          held: [0, 100, 'dead'],
          jumpReadyNext: false,
          survivesWithOneReplan: false,
        },
      ]),
    ),
  };
  for (const action of ['noop', 'left'])
    full.forecast.moves[action] = {
      next: [action === 'left' ? 4 : 5, 107, 'grounded'],
      held: action === 'left' ? [-9, 107, 'grounded'] : [29, 274, 'dead'],
      jumpReadyNext: true,
      survivesWithOneReplan: true,
    };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'rearmedSurvivalWitness');
  assert.deepEqual(request.state.outcomes.left, {
    rearmedSurvivalWitness: true,
  });
  full.forecast.moves.noop.next[0] = 16;
  assert.equal(decisionRequest(full).state.focus, 'movingSurvivalWitness');
});

test('body-length navigation uses pixels over the fixed held horizon at every cadence', () => {
  for (const frames of [4, 8, 16]) {
    const full = state();
    full.episode.stalledFrames = 192;
    full.forecast = {
      frames,
      heldFor: 60,
      moves: Object.fromEntries(
        Object.keys(ACTIONS).map((action) => [
          action,
          {
            next: [0, full.player.y, 'grounded'],
            held: [0, full.player.y, 'grounded'],
            jumpReadyNext: true,
            survivesWithOneReplan: true,
          },
        ]),
      ),
    };
    full.forecast.moves.left.next[0] = -frames / 4;
    full.forecast.moves.left.held[0] = -16;
    const moving = decisionRequest(full);
    assert.equal(moving.state.focus, 'horizontalSurvivalWitness');
    assert.deepEqual(moving.state.outcomes.left, {
      horizontalSurvivalWitness: true,
    });
    full.forecast.moves.left.held[0] = -15;
    assert.equal(decisionRequest(full).state.focus, undefined);
  }
});

test('horizontal escape cannot borrow displacement from a fatal or unfinished held path', () => {
  for (const frames of [4, 8, 16]) {
    const full = state();
    full.episode.stalledFrames = 192;
    full.forecast = {
      frames,
      heldFor: 60,
      moves: Object.fromEntries(
        Object.keys(ACTIONS).map((action) => [
          action,
          {
            next: [0, full.player.y, 'grounded'],
            held: [0, full.player.y, 'grounded'],
            jumpReadyNext: true,
            survivesWithOneReplan: true,
          },
        ]),
      ),
    };
    full.forecast.moves.left.next[0] = -frames / 4;
    full.forecast.moves.left.held[0] = -72;
    full.forecast.moves.right.next[0] = frames / 2;
    for (const phase of ['dead', 'falling', 'rising']) {
      full.forecast.moves.right.held = [64, full.player.y + 80, phase];
      const request = decisionRequest(full);
      assert.equal(request.state.focus, 'horizontalSurvivalWitness');
      assert.deepEqual(request.state.outcomes.right, {
        horizontalSurvivalWitness: false,
      });
      assert.deepEqual(request.state.outcomes.left, {
        horizontalSurvivalWitness: true,
      });
      assert.deepEqual(
        Object.keys(request.questions.move.criteria),
        Object.keys(ACTIONS),
      );
    }
    full.forecast.moves.right.held = [64, full.player.y, 'grounded'];
    assert.equal(
      decisionRequest(full).state.outcomes.right.horizontalSurvivalWitness,
      true,
    );
    full.forecast.moves.right.next[0] = 16;
    full.forecast.moves.right.held = [64, full.player.y + 80, 'dead'];
    assert.equal(
      decisionRequest(full).state.outcomes.right.horizontalSurvivalWitness,
      true,
      'actual first-interval motion with a surviving continuation remains eligible',
    );
  }
});

test('held survival distinguishes actions when the short readiness horizon finds no witness', () => {
  const full = state();
  full.player.y = 48;
  full.forecast = {
    frames: 4,
    heldFor: 60,
    continuationFrames: 16,
    readyStateLookaheadFrames: 52,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [12, 65, 'falling'],
          held: [138, 275, 'dead'],
          jumpReadyNext: false,
          survivesWithOneReplan: false,
        },
      ]),
    ),
  };
  for (const action of ['left', 'left_jump']) {
    full.forecast.moves[action].next[0] = 11;
    full.forecast.moves[action].held = [3, 176, 'falling'];
  }
  const original = structuredClone(full);
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'heldSurvivalWitness');
  assert.deepEqual(request.state.predictionScope, {
    firstActionFrames: 4,
    continuationFrames: 16,
    readinessSamplingFrames: 4,
    readinessLookaheadFrames: 52,
    heldForFrames: 60,
    missingReadinessWitness:
      'No qualifying boundary found within this bounded search; survival is unknown, not proven impossible.',
  });
  assert.deepEqual(Object.keys(request.state.outcomes), Object.keys(ACTIONS));
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  for (const action of Object.keys(ACTIONS))
    assert.deepEqual(request.state.outcomes[action], {
      heldSurvivalWitness: ['left', 'left_jump'].includes(action),
    });
  assert.deepEqual(full, original);

  full.forecast.moves.right_run_jump.survivesWithOneReplan = true;
  const replan = decisionRequest(full);
  assert.equal(replan.state.focus, 'movingSurvivalWitness');
  assert.deepEqual(replan.state.outcomes.right_run_jump, {
    movingSurvivalWitness: true,
  });
  full.forecast.moves.right_run_jump.survivesWithOneReplan = false;
  for (const action of ['left', 'left_jump'])
    full.forecast.moves[action].noSurvivingFollowup = true;
  assert.equal(decisionRequest(full).state.focus, 'viableNext');
  for (const move of Object.values(full.forecast.moves)) {
    move.noSurvivingFollowup = false;
    move.held[2] = 'falling';
  }
  assert.equal(decisionRequest(full).state.focus, undefined);
});

test('navigation distinguishes tiny inertial drift from a body-length displacement', () => {
  const full = state();
  full.player.y = 192;
  full.navigation.blockedPositions = [{ x: full.player.x + 20, y: 192 }];
  full.forecast = {
    frames: 16,
    heldFor: 60,
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 192, 'grounded'],
          held: [0, 192, 'grounded'],
          jumpReadyNext: true,
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.noop.held[0] = 2;
  full.forecast.moves.right_run.held[0] = 20;
  full.forecast.moves.left.held[0] = -16;
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'avoidsBlockAndMoves');
  assert.deepEqual(request.state.outcomes.noop, { avoidsBlockAndMoves: false });
  assert.deepEqual(request.state.outcomes.right_run, {
    avoidsBlockAndMoves: false,
  });
  assert.deepEqual(request.state.outcomes.left, { avoidsBlockAndMoves: true });
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.forecast.moves.left.held[0] = -15;
  assert.equal(decisionRequest(full).state.focus, undefined);
  full.forecast.moves.jump.held[1] = full.player.y - full.player.height;
  assert.deepEqual(decisionRequest(full).state.outcomes.jump, {
    avoidsBlockAndMoves: true,
  });
  full.forecast.moves.jump.held[1]++;
  assert.equal(decisionRequest(full).state.focus, undefined);
  full.forecast.moves.jump.next[1] = full.player.y - full.player.height;
  assert.deepEqual(decisionRequest(full).state.outcomes.jump, {
    avoidsBlockAndMoves: true,
  });
  full.navigation.blockedPositions = [];
  const fullOutcomes = decisionRequest(full).state.outcomes;
  assert.equal(fullOutcomes.noop.movesHeld, true);
  assert.equal(fullOutcomes.noop.movesBodyLength, false);
});

test('prolonged land stalls distinguish horizontal escape from repeated vertical motion', () => {
  const full = state();
  full.episode.stalledFrames = 180;
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, full.player.y - 32, 'rising'],
          held: [0, full.player.y, 'grounded'],
          jumpReadyNext: false,
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.left.next[0] = -16;
  full.forecast.moves.right.next[0] = 16;
  full.forecast.moves.right.noSurvivingFollowup = true;
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'horizontalSurvivalWitness');
  assert.deepEqual(request.state.outcomes.left, {
    horizontalSurvivalWitness: true,
  });
  assert.deepEqual(request.state.outcomes.jump, {
    horizontalSurvivalWitness: false,
  });
  assert.deepEqual(request.state.outcomes.right, {
    horizontalSurvivalWitness: false,
  });
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.episode.stalledFrames = 179;
  assert.notEqual(
    decisionRequest(full).state.focus,
    'horizontalSurvivalWitness',
  );
  full.episode.stalledFrames = 180;
  full.player.swimming = true;
  assert.notEqual(
    decisionRequest(full).state.focus,
    'horizontalSurvivalWitness',
  );
  full.player.swimming = false;
  full.forecast.moves.left.next[0] = -15;
  assert.notEqual(
    decisionRequest(full).state.focus,
    'horizontalSurvivalWitness',
  );
  full.forecast.moves.left.next[0] = -16;
  full.forecast.moves.left.survivesWithOneReplan = false;
  assert.notEqual(
    decisionRequest(full).state.focus,
    'horizontalSurvivalWitness',
  );
});

test('a witnessed higher landing takes priority over repeated horizontal retreats', () => {
  const full = state();
  full.episode.stalledFrames = 200;
  full.navigation.climbFloors = [{ topY: 96, startX: 80, endX: 96 }];
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [action === 'left' ? -32 : 0, full.player.y - 32, 'rising'],
          held: [0, full.player.y, 'grounded'],
          jumpReadyNext: false,
          survivesWithOneReplan: true,
          climbLanding: action === 'right_jump',
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'climbingWitness');
  assert.equal(request.state.outcomes.right_jump.climbingWitness, true);
  assert.equal(request.state.outcomes.left.climbingWitness, false);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
  full.navigation.climbFloors = [];
  full.navigation.higherLandingY = 96;
  assert.equal(decisionRequest(full).state.focus, 'climbingWitness');
  full.forecast.moves.right_jump.climbLanding = undefined;
  assert.throws(() => decisionRequest(full), /climbing landing forecast/);
});

test('a run-up witness can favor retreat while retaining every native option', () => {
  const full = state();
  full.episode.stalledFrames = 200;
  full.navigation.runJumpTargetX = 200;
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [-16, full.player.y, 'grounded'],
          held: [-32, full.player.y, 'grounded'],
          jumpReadyNext: true,
          survivesWithOneReplan: true,
          runJumpLanding: action === 'left',
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'runJumpWitness');
  assert.equal(request.state.outcomes.left.runJumpWitness, true);
  assert.equal(request.state.outcomes.right_run.runJumpWitness, false);
  assert.equal(Object.keys(request.questions.move.criteria).length, 9);
  full.navigation.higherLandingY = 96;
  for (const [action, move] of Object.entries(full.forecast.moves))
    move.climbLanding = action === 'right_jump';
  assert.equal(
    decisionRequest(full).state.focus,
    'runJumpWitness',
    'landing beyond the observed gap takes priority over an intermediate higher landing',
  );
  full.forecast.moves.left.runJumpLanding = false;
  assert.equal(decisionRequest(full).state.focus, 'climbingWitness');
  full.forecast.moves.left.runJumpLanding = true;
  full.forecast.moves.left.noSurvivingFollowup = true;
  assert.notEqual(decisionRequest(full).state.focus, 'runJumpWitness');
  full.forecast.moves.left.runJumpLanding = undefined;
  assert.throws(() => decisionRequest(full), /run-jump landing forecast/);
});

test('spring focus preserves height opportunities and release readiness without removing choices', () => {
  const full = state();
  full.hazard.enemies = [{ kind: 50, dx: -18 }];
  full.terrain.obstacleAhead = { topY: 48, distancePixels: 0 };
  full.recent_control.heldJump = true;
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 170, 'grounded'],
          held: [0, 192, 'grounded'],
          highestY: 120,
          jumpReadyNext: !action.includes('jump'),
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  assert.equal(decisionRequest(full).state.focus, 'rearmsSpring');
  assert.deepEqual(decisionRequest(full).state.outcomes.right, {
    rearmsSpring: true,
  });
  assert.deepEqual(decisionRequest(full).state.outcomes.right_jump, {
    rearmsSpring: false,
  });
  full.forecast.moves.right_jump.highestY = 32;
  const high = decisionRequest(full);
  assert.equal(high.state.focus, 'springHeight');
  assert.deepEqual(high.state.outcomes.right_jump, { springHeight: true });
  assert.deepEqual(high.state.outcomes.right, { springHeight: false });
  assert.deepEqual(
    Object.keys(high.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.forecast.moves.right_jump.noSurvivingFollowup = true;
  assert.equal(decisionRequest(full).state.focus, 'movingSurvivalWitness');
  assert.deepEqual(decisionRequest(full).state.outcomes.right_jump, {
    movingSurvivalWitness: false,
  });
  full.forecast.moves.right_jump.noSurvivingFollowup = false;
  full.forecast.moves.right_jump.highestY = 120;
  assert.equal(decisionRequest(full).state.focus, 'rearmsSpring');
  full.hazard.enemies = [];
  assert.notEqual(decisionRequest(full).state.focus, 'rearmsSpring');
});

test('spring height cannot hide an available movement or rearming survival witness', () => {
  for (const frames of [4, 8, 16]) {
    const full = state();
    full.player.y = 192;
    full.hazard.enemies = [{ kind: 50, dx: -18 }];
    full.terrain.obstacleAhead = { topY: 160, distancePixels: 0 };
    full.forecast = {
      frames,
      moves: Object.fromEntries(
        Object.keys(ACTIONS).map((action) => [
          action,
          {
            next: [6, 173, 'rising'],
            held: [60, 272, 'dead'],
            highestY: action.includes('jump') ? 140 : 192,
            jumpReadyNext: false,
            survivesWithOneReplan: action === 'left_jump',
          },
        ]),
      ),
    };
    const request = decisionRequest(full);
    assert.equal(request.state.focus, 'movingSurvivalWitness');
    assert.deepEqual(
      Object.entries(request.state.outcomes)
        .filter(([, value]) => value.movingSurvivalWitness)
        .map(([action]) => action),
      ['left_jump'],
    );
    assert.deepEqual(
      Object.keys(request.questions.move.criteria),
      Object.keys(ACTIONS),
    );
    full.forecast.moves.left_jump.survivesWithOneReplan = false;
    assert.equal(decisionRequest(full).state.focus, 'springHeight');
    full.recent_control.jumpReady = false;
    Object.assign(full.forecast.moves.noop, {
      next: [0, 192, 'grounded'],
      jumpReadyNext: true,
      survivesWithOneReplan: true,
    });
    assert.equal(decisionRequest(full).state.focus, 'rearmedSurvivalWitness');
  }
});

test('small airborne motion retains preparation evidence before default held displacement', () => {
  for (const frames of [4, 8, 16]) {
    for (const nearSpring of [false, true]) {
      const full = state();
      full.player.y = 73;
      full.player.grounded = false;
      full.recent_control.jumpReady = false;
      full.hazard.enemies = nearSpring ? [{ kind: 50, dx: -18 }] : [];
      full.terrain.obstacleAhead = { topY: 48, distancePixels: 0 };
      full.forecast = {
        frames,
        moves: Object.fromEntries(
          Object.keys(ACTIONS).map((action) => [
            action,
            {
              next: [0, 73 - frames / 2, 'rising'],
              held: [80, 273, 'dead'],
              highestY: 32,
              jumpReadyNext: false,
              survivesWithOneReplan: ['jump', 'left', 'left_jump'].includes(
                action,
              ),
            },
          ]),
        ),
      };
      const request = decisionRequest(full);
      assert.equal(request.state.focus, 'airborneSurvivalWitness');
      assert.deepEqual(
        Object.entries(request.state.outcomes)
          .filter(([, value]) => value.airborneSurvivalWitness)
          .map(([action]) => action),
        ['jump', 'left', 'left_jump'],
      );
      assert.deepEqual(
        Object.keys(request.questions.move.criteria),
        Object.keys(ACTIONS),
      );
      full.player.grounded = true;
      assert.notEqual(
        decisionRequest(full).state.focus,
        'airborneSurvivalWitness',
      );
    }
  }
});

test('known maze approaches can advance past a blockage without overriding connected routes or the gate buffer', () => {
  for (const frames of [4, 8, 16]) {
    const full = state();
    full.player.x = 1454;
    full.player.y = 144;
    full.navigation.blockedPositions = [{ x: 1490, y: 144 }];
    full.navigation.mazeRoute = {
      gateX: 2067,
      failedFloorYs: [96],
      alternativeFloorYs: [160, 208],
    };
    full.forecast = {
      frames,
      moves: Object.fromEntries(
        Object.keys(ACTIONS).map((action) => [
          action,
          {
            next: [
              action.startsWith('right') ? frames / 2 : 0,
              144,
              'grounded',
            ],
            held: [action.startsWith('right') ? 36 : 0, 144, 'grounded'],
            jumpReadyNext: true,
            survivesWithOneReplan: true,
            mazeLanding: false,
            mazeConnectedLanding: false,
          },
        ]),
      ),
    };
    const request = decisionRequest(full);
    assert.equal(request.state.focus, 'forwardSurvivalWitness');
    assert.deepEqual(
      Object.entries(request.state.outcomes)
        .filter(([, value]) => value.forwardSurvivalWitness)
        .map(([action]) => action),
      ['right', 'right_jump', 'right_run', 'right_run_jump'],
    );
    Object.assign(full.forecast.moves.left, {
      held: [-32, 144, 'grounded'],
      mazeLanding: true,
      mazeConnectedLanding: true,
    });
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    full.forecast.moves.left.mazeConnectedLanding = false;
    full.forecast.moves.left.mazeLanding = false;
    full.player.x = full.navigation.mazeRoute.gateX - 64;
    full.navigation.blockedPositions = [{ x: full.player.x + 36, y: 144 }];
    assert.notEqual(
      decisionRequest(full).state.focus,
      'forwardSurvivalWitness',
    );
    full.player.x--;
    full.navigation.blockedPositions[0].x--;
    assert.equal(decisionRequest(full).state.focus, 'forwardSurvivalWitness');
    assert.deepEqual(
      Object.keys(request.questions.move.criteria),
      Object.keys(ACTIONS),
    );
  }
});

test('observed maze routes use landing witnesses, not airborne height or resetting actions', () => {
  const full = state();
  full.navigation.mazeRoute = {
    gateX: 1000,
    failedFloorYs: [208],
    alternativeFloorYs: [96],
  };
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [20, 80, 'falling'],
          held: [40, 192, 'grounded'],
          jumpReadyNext: false,
          survivesWithOneReplan: true,
          mazeLanding: action === 'right_jump',
          mazeConnectedLanding: false,
        },
      ]),
    ),
  };
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'towardMazeRoute');
  full.forecast.moves.left.mazeConnectedLanding = true;
  const connected = decisionRequest(full);
  assert.equal(connected.state.outcomes.left.towardMazeRoute, true);
  assert.equal(connected.state.outcomes.right_jump.towardMazeRoute, false);
  assert.equal(Object.keys(connected.questions.move.criteria).length, 9);
  full.forecast.moves.left.mazeConnectedLanding = false;
  assert.deepEqual(request.state.outcomes.right_jump, {
    towardMazeRoute: true,
  });
  assert.deepEqual(request.state.outcomes.right, { towardMazeRoute: false });
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  assert.deepEqual(request.state.game.memory, []);
  full.forecast.moves.left.survivesWithOneReplan = false;
  assert.equal(decisionRequest(full).state.focus, 'forwardSurvivalWitness');
  full.forecast.moves.left.survivesWithOneReplan = true;
  full.forecast.moves.right_jump.repeatsMaze = true;
  assert.notEqual(decisionRequest(full).state.focus, 'towardMazeRoute');
  full.forecast.moves.right_jump.groundedMazeReset = true;
  assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
  full.forecast.moves.right_jump.next = [0, full.player.y, 'grounded'];
  full.forecast.moves.right_jump.held = [0, full.player.y, 'grounded'];
  assert.notEqual(decisionRequest(full).state.focus, 'towardMazeRoute');
  full.recent_control.jumpReady = false;
  full.forecast.moves.right_jump.jumpReadyNext = true;
  assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
  full.forecast.moves.right_jump.mazeLanding = undefined;
  assert.throws(() => decisionRequest(full), /maze landing forecast/);
});

test('stalled unknown checkpoints can request new feedback without calling failure a successful route', () => {
  for (const frames of [4, 8, 16]) {
    const full = state();
    full.reaction_timing.framesPerDecision = frames;
    full.episode.stalledFrames = 179;
    const checkpoint = {
      page: 6,
      gateX: 1287,
      correctFloorYs: [],
      failedFloorYs: [],
    };
    full.navigation.mazeRoute = {
      gateX: 1287,
      checkpointPage: 6,
      failedFloorYs: [],
      alternativeFloorYs: [96, 208],
    };
    full.navigation.mazeFeedback = { checkpoints: [checkpoint] };
    const feedback = { page: 6, floorY: 208, correct: false };
    full.forecast = {
      frames,
      moves: Object.fromEntries(
        Object.keys(ACTIONS).map((action) => [
          action,
          {
            next: [20, full.player.y, 'grounded'],
            held: [40, full.player.y, 'grounded'],
            jumpReadyNext: true,
            survivesWithOneReplan: true,
            mazeLanding: action === 'left',
            mazeConnectedLanding: action === 'left',
            mazeCheckpointFeedbackHeld: action === 'right' ? [feedback] : [],
          },
        ]),
      ),
    };
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    full.episode.stalledFrames = 180;
    const request = decisionRequest(full);
    assert.equal(request.state.focus, 'revealsMazeCheckpoint');
    assert.deepEqual(request.state.outcomes.right, {
      revealsMazeCheckpoint: true,
    });
    assert.deepEqual(request.state.outcomes.left, {
      revealsMazeCheckpoint: false,
    });
    assert.equal(Object.keys(request.questions.move.criteria).length, 9);
    assert.match(
      request.questions.move.instructions,
      /information gathering, not proof/,
    );
    feedback.correct = null;
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    feedback.correct = false;
    feedback.floorY = null;
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    feedback.floorY = 208;
    checkpoint.failedFloorYs.push(208);
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    checkpoint.failedFloorYs = [];
    full.forecast.moves.right.survivesWithOneReplan = false;
    assert.notEqual(decisionRequest(full).state.focus, 'revealsMazeCheckpoint');
    full.forecast.moves.right.survivesWithOneReplan = true;
    checkpoint.correctFloorYs.push(96);
    assert.equal(decisionRequest(full).state.focus, 'towardMazeRoute');
    full.episode.stalledFrames = 0;
    full.navigation.mazeFeedback.checkedInSequence = 2;
    full.navigation.mazeFeedback.correctInSequence = 1;
    feedback.correct = null;
    feedback.floorY = null;
    feedback.sequenceEnded = true;
    feedback.sequenceCorrect = false;
    full.navigation.higherLandingY = 144;
    for (const [action, move] of Object.entries(full.forecast.moves))
      move.climbLanding = action === 'left';
    const retry = decisionRequest(full);
    assert.equal(retry.state.focus, 'retriesFailedMazeSequence');
    assert.deepEqual(retry.state.outcomes.right, {
      retriesFailedMazeSequence: true,
    });
    assert.match(
      retry.questions.move.instructions,
      /does not restart the campaign/,
    );
    full.navigation.mazeFeedback.correctInSequence = 2;
    assert.equal(decisionRequest(full).state.focus, 'climbingWitness');
    full.navigation.mazeFeedback.correctInSequence = 1;
    feedback.sequenceCorrect = null;
    assert.equal(decisionRequest(full).state.focus, 'climbingWitness');
    feedback.sequenceCorrect = false;
    full.forecast.moves.right.survivesWithOneReplan = false;
    assert.notEqual(
      decisionRequest(full).state.focus,
      'retriesFailedMazeSequence',
    );
  }
});

test('navigation accepts a moving release before replanning instead of requiring a useful long hold', () => {
  const full = state();
  full.player.y = 192;
  full.recent_control.heldJump = true;
  full.recent_control.jumpReady = false;
  full.navigation.blockedPositions = [{ x: full.player.x, y: 192 }];
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 192, 'grounded'],
          held: [0, 192, 'grounded'],
          jumpReadyNext: !action.includes('jump'),
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.right.next = [0, 185, 'rising'];
  full.forecast.moves.left.next[0] = -16;
  full.forecast.moves.left.held[0] = -60;
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'avoidsBlockAndMoves');
  assert.deepEqual(request.state.outcomes.right, { avoidsBlockAndMoves: true });
  assert.deepEqual(request.state.outcomes.noop, { avoidsBlockAndMoves: false });
  full.recent_control.heldJump = false;
  full.recent_control.jumpReady = true;
  assert.deepEqual(decisionRequest(full).state.outcomes.right, {
    avoidsBlockAndMoves: false,
  });
  full.recent_control.jumpReady = false;
  assert.deepEqual(decisionRequest(full).state.outcomes.right, {
    avoidsBlockAndMoves: true,
  });
  for (const move of Object.values(full.forecast.moves))
    move.next[1] = full.player.y - full.player.height;
  const identical = decisionRequest(full);
  assert.equal(identical.state.focus, undefined);
  assert.equal(identical.state.outcomes.right.forwardNext, 0);
});

test('a forward water drop below the visible playfield can focus surviving upward motion', () => {
  const full = state();
  Object.assign(full.player, { swimming: true, y: 100, height: 16 });
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [20, 100, 'falling'],
          held: [50, 192, 'grounded'],
          jumpReadyNext: !action.includes('jump'),
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.right_run.held = [50, 224, 'falling'];
  full.forecast.moves.right_jump.next[1] = 82;
  const request = decisionRequest(full);
  assert.equal(request.state.focus, 'risesSafely');
  assert.deepEqual(request.state.outcomes.right_jump, { risesSafely: true });
  assert.deepEqual(request.state.outcomes.right_run, { risesSafely: false });
  full.recent_control.heldJump = true;
  const rearmed = decisionRequest(full);
  assert.equal(rearmed.state.focus, 'rearmsStroke');
  assert.deepEqual(rearmed.state.outcomes.right_run, { rearmsStroke: true });
  assert.deepEqual(rearmed.state.outcomes.right_jump, { rearmsStroke: false });
  assert.deepEqual(
    Object.keys(rearmed.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.recent_control.heldJump = false;
  assert.deepEqual(
    Object.keys(request.questions.move.criteria),
    Object.keys(ACTIONS),
  );
  full.forecast.moves.right_run.held[1]--;
  assert.equal(decisionRequest(full).state.focus, undefined);
  full.forecast.moves.right_run.held[1]++;
  full.forecast.moves.right_run.held[2] = 'grounded';
  assert.equal(decisionRequest(full).state.focus, undefined);
  full.forecast.moves.right_run.held[2] = 'falling';
  full.player.swimming = false;
  assert.equal(decisionRequest(full).state.focus, undefined);
});

test('a short new swim stroke is useful without pretending it moved a full body height', () => {
  const full = state();
  Object.assign(full.player, { swimming: true, y: 192, height: 16 });
  full.forecast = {
    moves: Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        {
          next: [0, 192, 'grounded'],
          held: [0, 192, 'grounded'],
          jumpReadyNext: !action.includes('jump'),
          survivesWithOneReplan: true,
        },
      ]),
    ),
  };
  full.forecast.moves.right_jump.next = [0, 179, 'rising'];
  full.forecast.moves.right_jump.held = [0, 186, 'falling'];
  const outcome = decisionRequest(full).state.outcomes.right_jump;
  assert.equal(outcome.movesBodyLength, false);
  assert.equal(outcome.startsSwimStroke, true);
  full.navigation.blockedPositions = [{ x: full.player.x, y: 192 }];
  full.forecast.moves.left.held[0] = -60;
  assert.deepEqual(decisionRequest(full).state.outcomes.right_jump, {
    avoidsBlockAndMoves: true,
  });
  full.recent_control.jumpReady = false;
  assert.deepEqual(decisionRequest(full).state.outcomes.right_jump, {
    avoidsBlockAndMoves: false,
  });
});
