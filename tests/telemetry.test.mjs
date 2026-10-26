import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Telemetry,
  narrowSupportContext,
  readPlayer,
  tileAt,
} from '../telemetry.mjs';
import { ramFixture } from './fixtures.mjs';

test('hidden blocks are not floors; looped pipe preparation retains revealed support behind Mario', () => {
  for (const hidden of [0x5f, 0x60]) {
    const ram = ramFixture();
    ram[0x86] = 112;
    ram[0x500 + 7 * 16 + 4] = hidden;
    ram[0x500 + 4 * 16 + 8] = 0x10;
    ram[0x500 + 4 * 16 + 9] = 0x11;
    const parser = new Telemetry(16);
    parser.sample(ram, 0);
    parser.observedLoopCount = 1;
    let state = parser.sample(ram, 200, 'noop');
    assert.deepEqual(state.terrain.hiddenBlocks, [{ x: 64, y: 144 }]);
    assert.ok(!state.terrain.surfaces.some((floor) => floor.topY === 144));
    assert.ok(
      !state.navigation.climbFloors.some((floor) => floor.topY === 144),
    );
    ram[0x500 + 7 * 16 + 4] = 0xc4;
    state = parser.sample(ram, 216, 'noop');
    assert.deepEqual(state.terrain.hiddenBlocks, []);
    assert.ok(
      state.navigation.climbFloors.some(
        (floor) =>
          floor.topY === 144 && floor.startX === 64 && floor.endX === 80,
      ),
    );
  }
});

test('real narrow-support cadence shares the prediction geometry rule and preserves lower caps', () => {
  for (const configured of [4, 8, 16]) {
    for (const tile of [0x5f, 0x23, 0xc4]) {
      const ram = ramFixture();
      ram[0x500 + 7 * 16 + 4] = tile;
      ram[0x500 + 4 * 16 + 8] = 0x10;
      ram[0x500 + 4 * 16 + 9] = 0x11;
      const parser = new Telemetry(configured);
      assert.equal(
        parser.sample(ram, 0).reaction_timing.framesPerDecision,
        configured,
      );
      parser.observedLoopCount = 1;
      const state = parser.sample(ram, 16);
      const context = narrowSupportContext(ram, state.player, 1);
      assert.equal(context.nearby, true);
      assert.equal(
        state.reaction_timing.framesPerDecision,
        Math.min(configured, context.frameCap),
      );
      assert.deepEqual(state.navigation.narrowSupports ?? [], context.supports);
      assert.equal(context.supports.length, tile === 0x5f ? 0 : 1);
      if (context.supports.length)
        assert.equal(context.supports[0].ready, tile === 0xc4);
      ram[0xf] = 1;
      ram[0x16] = 0x32;
      ram[0x87] = 40;
      assert.equal(parser.sample(ram, 32).reaction_timing.framesPerDecision, 4);
      ram[0xf] = 0;
      ram[0x500 + 4 * 16 + 8] = 0;
      assert.equal(narrowSupportContext(ram, readPlayer(ram), 1).nearby, false);
      assert.equal(
        parser.sample(ram, 48).reaction_timing.framesPerDecision,
        configured,
      );
    }
  }
});

test('hidden blocks do not create native maze floors or horizontal blockages', () => {
  const ram = ramFixture();
  ram[0x500 + 7 * 16 + 4] = 0x5f;
  ram[0x500 + 8 * 16 + 4] = 0x54;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  assert.equal(parser.observedFloors.get(144).has(64), false);
  assert.equal(parser.observedFloors.get(160).has(64), true);
  ram[0x86] = 48;
  ram[0xce] = 120;
  parser.sample(ram, 16);
  const state = parser.sample(ram, 32, 'right');
  assert.deepEqual(state.navigation.blockedPositions, []);
});

test('player coordinates, HUD, death and flag completion', () => {
  const ram = ramFixture();
  assert.deepEqual(
    Object.fromEntries(
      ['x', 'y', 'time', 'lives', 'grounded'].map((key) => [
        key,
        readPlayer(ram)[key],
      ]),
    ),
    { x: 40, y: 208, time: 400, lives: 3, grounded: true },
  );
  ram[0x6d] = 2;
  assert.equal(readPlayer(ram).x, 552);
  for (const state of [6, 11]) {
    ram[0x0e] = state;
    assert.equal(readPlayer(ram).dead, true);
    assert.equal(readPlayer(ram).automatic, true);
    assert.equal(readPlayer(ram).gameOver, false);
  }
  ram[0x0e] = 8;
  ram[0xb5] = 2;
  assert.equal(readPlayer(ram).dead, true);
  ram[0xb5] = 1;
  ram[0x1d] = 3;
  assert.equal(readPlayer(ram).clear, false, 'vine is not a flag');
  ram[0x16] = 0x31;
  ram[0x0e] = 4;
  assert.equal(
    readPlayer(ram).levelClear,
    false,
    'inactive flag object is not completion',
  );
  ram[0xf] = 1;
  assert.equal(readPlayer(ram).levelClear, true);
  assert.equal(readPlayer(ram).clear, false);
  ram[0x1d] = 0;
  ram[0x770] = 2;
  assert.equal(readPlayer(ram).levelClear, true);
  assert.equal(
    readPlayer(ram).clear,
    false,
    'earlier castles are not final victory',
  );
  ram[0x75f] = 7;
  ram[0x75c] = 3;
  assert.equal(readPlayer(ram).clear, true);
});

test('game over is distinct from a recoverable death', () => {
  const ram = ramFixture();
  ram[0x75a] = 255;
  assert.equal(readPlayer(ram).gameOver, true);
  assert.equal(readPlayer(ram).automatic, false);
  assert.equal(readPlayer(ram).lives, 0);
  ram[0x75a] = 2;
  ram[0x770] = 3;
  assert.equal(readPlayer(ram).gameOver, true);
});

test('pipe descent and loading are not confused with falling to death', () => {
  const ram = ramFixture();
  ram[0x0e] = 3;
  ram[0xb5] = 2;
  assert.equal(readPlayer(ram).dead, false);
  assert.equal(readPlayer(ram).automatic, true);
  assert.equal(readPlayer(ram).controllable, false);
  ram[0x0e] = 8;
  ram[0xb5] = 1;
  ram[0x772] = 0;
  assert.equal(readPlayer(ram).automatic, true);
  assert.equal(readPlayer(ram).grounded, false);
});

test('all 32 distinct level clears are required; world-transition bookkeeping cannot count the next level', () => {
  const parser = new Telemetry(16);
  let frame = 0;
  let snapshot;
  for (let world = 1; world <= 8; world++) {
    for (let stage = 1; stage <= 4; stage++) {
      const ram = ramFixture();
      ram[0x75f] = world - 1;
      ram[0x75c] = stage - 1;
      parser.sample(ram, frame++);
      if (stage === 4) ram[0x770] = 2;
      else {
        ram[0x0e] = 4;
        ram[0x1d] = 3;
        ram[0xf] = 1;
        ram[0x16] = 0x31;
      }
      snapshot = parser.sample(ram, frame++);
      assert.equal(
        snapshot.campaign.completedLevels.length,
        (world - 1) * 4 + stage,
      );
      assert.equal(
        snapshot.episode.terminal,
        world === 8 && stage === 4 ? 'clear' : null,
      );
      assert.equal(
        parser.sample(ram, frame++).campaign.completedLevels.length,
        snapshot.campaign.completedLevels.length,
        'do not count one clear twice',
      );
      if (stage === 4 && world < 8) {
        ram[0x75f]++;
        ram[0x75c] = 0;
        assert.equal(
          parser.sample(ram, frame++).campaign.completedLevels.length,
          world * 4,
        );
      }
    }
  }
  assert.equal(snapshot.campaign.completedLevels.at(-1), '8-4');
});

test('area changes reset positional history and grounded terrain without losing completed levels', () => {
  const ram = ramFixture();
  const parser = new Telemetry(16);
  ram[0x6d] = 8;
  parser.sample(ram, 0);
  parser.completedLevels.add('1-1');
  ram[0x750] = 0xc2;
  ram[0xe7] = 1;
  ram[0x6d] = 0;
  ram[0x86] = 24;
  ram[0x1d] = 1;
  const snapshot = parser.sample(ram, 16);
  assert.equal(snapshot.trajectory.velocityX, null);
  assert.equal(snapshot.episode.bestX, 24);
  assert.equal(snapshot.episode.stalledFrames, 0);
  assert.equal(snapshot.terrain.lastGroundedPreview, null);
  assert.deepEqual(snapshot.campaign.completedLevels, ['1-1']);
});

test('missing RAM and malformed HUD are explicit errors', () => {
  assert.throws(() => readPlayer(null), /2 KiB/);
  const ram = ramFixture();
  ram[0x7f8] = 255;
  assert.throws(() => readPlayer(ram), /HUD/);
});

test('parsed pipe destinations do not reset loaded-area loop or positional history', () => {
  const ram = ramFixture();
  const parser = new Telemetry(16);
  ram[0xe7] = 0xfc;
  ram[0xe8] = 0xa3;
  parser.sample(ram, 0);
  ram[0x750] = 0xe5;
  const repeated = parser.sample(ram, 16, 'noop', {
    mazeReset: { x: 1283, feet: 160, grounded: false },
  });
  assert.equal(repeated.player.areaDataAddress, 0xa3fc);
  assert.equal(repeated.campaign.areaChanged, false);
  assert.equal(repeated.navigation.observedLoopCount, 1);
  assert.equal(repeated.episode.stalledFrames, 16);
  ram[0x750] = 0x65;
  assert.equal(parser.sample(ram, 32).navigation.observedLoopCount, 1);
  ram[0xe7]++;
  const changed = parser.sample(ram, 48);
  assert.equal(changed.campaign.areaChanged, true);
  assert.equal(changed.navigation.observedLoopCount, undefined);
  assert.equal(changed.episode.stalledFrames, 0);
});

test('only observed adjacent enterable pipe-top metatiles produce pipe geometry', () => {
  const ram = ramFixture();
  ram[0x500 + 8 * 16 + 3] = 0x54;
  ram[0x500 + 8 * 16 + 4] = 0x10;
  ram[0x500 + 8 * 16 + 5] = 0x11;
  ram[0x500 + 8 * 16 + 6] = 0x10;
  assert.deepEqual(new Telemetry(16).sample(ram, 0).terrain.pipeTops, [
    { startX: 64, endX: 96, topY: 160 },
  ]);
});

test('an observed loop without alternate floor segments does not disable a real gap target', () => {
  const ram = ramFixture();
  ram[0x500 + 12 * 16 + 6] = 0;
  ram[0x500 + 12 * 16 + 7] = 0;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  parser.mazeRoute = {
    gateX: 300,
    failedFloorYs: [224],
    alternativeFloorYs: [],
    alternativeFloors: [],
  };
  const snapshot = parser.sample(ram, 180);
  assert.equal(snapshot.navigation.runJumpTargetX, 128);
  assert.deepEqual(snapshot.navigation.mazeRoute.alternativeFloors, []);
});

test('small Mario occupies the lower half of the RAM anchor; growth is not motion', () => {
  const ram = ramFixture();
  const parser = new Telemetry(8);
  const small = parser.sample(ram, 0);
  assert.equal(small.player.height, 16);
  assert.equal(small.player.y, ram[0xce] + 16);
  ram[0x754] = 0;
  const big = parser.sample(ram, 8);
  assert.equal(big.player.height, 32);
  assert.equal(big.player.y, ram[0xce]);
  assert.equal(big.trajectory.velocityY, 0);
});

test('jumping RAM state does not incorrectly label falling as rising', () => {
  const ram = ramFixture();
  ram[0x1d] = 1;
  ram[0x9f] = 251;
  assert.equal(readPlayer(ram).jumpPhase, 'rising');
  ram[0x9f] = 3;
  assert.equal(readPlayer(ram).jumpPhase, 'falling');
  const snapshot = new Telemetry(16).sample(ram, 0, 'right_run_jump', {
    headBump: true,
    landed: true,
  });
  assert.equal(snapshot.recent_control.headBump, true);
  assert.equal(snapshot.recent_control.jumpReady, false);
  ram[0x1d] = 0;
  assert.equal(
    new Telemetry(16).sample(ram, 0, 'right_run_jump').recent_control.jumpReady,
    false,
  );
  assert.equal(
    new Telemetry(16).sample(ram, 0, 'right').recent_control.jumpReady,
    true,
  );
  ram[0x1d] = 1;
  assert.equal(
    new Telemetry(16).sample(ram, 0, 'right').recent_control.jumpReady,
    false,
  );
  ram[0x704] = 1;
  const swimmer = new Telemetry(16).sample(ram, 0, 'right');
  assert.equal(swimmer.player.swimming, true);
  assert.equal(swimmer.player.grounded, false);
  assert.equal(swimmer.recent_control.jumpReady, true);
  assert.equal(swimmer.reaction_timing.framesPerDecision, 8);
  assert.equal(swimmer.reaction_timing.collisionLookaheadFrames, 24);
  assert.equal(
    new Telemetry(4).sample(ram, 0).reaction_timing.framesPerDecision,
    4,
  );
  assert.equal(
    new Telemetry(16).sample(ram, 0, 'right_jump').recent_control.jumpReady,
    false,
  );
  ram[0x9f] = 255;
  ram[0x782] = 1;
  assert.equal(readPlayer(ram).jumpAvailable, false);
  ram[0x782] = 2;
  assert.equal(readPlayer(ram).jumpAvailable, true);
  ram[0x782] = 0;
  ram[0x9f] = 0;
  assert.equal(readPlayer(ram).jumpAvailable, true);
});

test('tile ring buffer page boundaries and unknown offscreen geometry', () => {
  const ram = ramFixture();
  ram[0x500 + 208 + 192] = 0x77;
  assert.equal(tileAt(ram, 255, 224, 200), 0x54);
  assert.equal(tileAt(ram, 256, 224, 200), 0x77);
  assert.equal(tileAt(ram, 456, 224, 200), null);
  assert.equal(tileAt(ram, 199, 224, 200), null);
  assert.equal(tileAt(ram, 240, 16, 200), null);
  assert.equal(tileAt(ram, 512, 224, 500), 0x54);
});

test('terrain distinguishes possible gaps, body obstacles and unseen columns', () => {
  const ram = ramFixture();
  ram[0x500 + 192 + 4] = 0;
  ram[0x500 + 176 + 5] = 0x54;
  const state = new Telemetry(8).sample(ram, 0);
  assert.deepEqual(state.terrain.possibleGaps, [{ startX: 64, endX: 80 }]);
  assert.ok(
    state.terrain.surfaces.some(
      (surface) => surface.startX === 80 && surface.topY === 208,
    ),
  );
  assert.deepEqual(state.terrain.observedX, [32, 192]);
  ram[0x86] = 240;
  const edge = new Telemetry(8).sample(ram, 0);
  assert.deepEqual(edge.terrain.observedX, [240, 256]);
  assert.deepEqual(edge.terrain.possibleGaps, []);
});

test('temporal velocities are per frame and initial estimates are unknown', () => {
  const ram = ramFixture();
  ram[0xf] = 1;
  ram[0x16] = 0; // Active green Koopa, not an empty slot.
  ram[0x87] = 100;
  ram[0xcf] = 208;
  ram[0xb6] = 1;
  const parser = new Telemetry(8);
  const first = parser.sample(ram, 0);
  assert.equal(first.hazard.enemies[0].name, 'green_koopa');
  assert.equal(first.hazard.enemies[0].relativeVelocity, null);
  ram[0x86] += 16;
  ram[0x87] -= 8;
  ram[0x1d] = 1;
  ram[0xce] -= 24;
  const next = parser.sample(ram, 8, 'right_run_jump');
  assert.equal(next.trajectory.velocityX, 2);
  assert.equal(next.trajectory.velocityY, -3);
  assert.equal(next.hazard.enemies[0].relativeVelocity, -3);
  assert.equal(next.hazard.enemies[0].projectedDx, 12);
  assert.ok(next.hazard.enemies[0].contactInFrames > 0);
  assert.equal(next.hazard.imminentCollision, true);
  assert.equal(next.terrain.lastGroundedPreview.frame, 0);
  assert.equal(next.reaction_timing.inferenceDelayFrames, 0);
  assert.equal(next.recent_control.heldJump, true);
  assert.throws(() => parser.sample(ram, 8), /advance/);
});

test('stalls accumulate emulator frames, not inference wall time', () => {
  const ram = ramFixture();
  const parser = new Telemetry(8);
  parser.sample(ram, 0);
  assert.equal(parser.sample(ram, 8).episode.stalledFrames, 8);
  ram[0x86]++;
  assert.equal(parser.sample(ram, 16).episode.stalledFrames, 0);
  ram[0x86] -= 10;
  assert.equal(parser.sample(ram, 24).episode.stalledFrames, 8);
  ram[0x86] += 5;
  assert.equal(parser.sample(ram, 32).episode.stalledFrames, 16);
  ram[0x86] += 5;
  assert.equal(parser.sample(ram, 40).episode.stalledFrames, 24);
  ram[0x86]++;
  assert.equal(parser.sample(ram, 48).episode.stalledFrames, 0);
});

test('equal physical stall time preserves navigation targets across control cadences', () => {
  let reference;
  for (const cadence of [4, 8, 16]) {
    const ram = ramFixture();
    ram[0x500 + 4 * 16 + 5] = 1;
    ram[0x500 + 12 * 16 + 6] = 0;
    ram[0x500 + 12 * 16 + 7] = 0;
    const parser = new Telemetry(cadence);
    parser.sample(ram, 0);
    let firstTargetFrame;
    let snapshot;
    for (let frame = cadence; frame <= 192; frame += cadence) {
      snapshot = parser.sample(ram, frame, 'noop');
      assert.equal(snapshot.episode.stalledFrames, frame);
      if (frame < 180) {
        assert.equal(snapshot.navigation.runJumpTargetX, undefined);
        assert.equal(snapshot.navigation.climbFloors, undefined);
      } else {
        firstTargetFrame ??= frame;
        assert.equal(snapshot.navigation.runJumpTargetX, 128);
        assert.ok(snapshot.navigation.climbFloors.length > 0);
      }
    }
    assert.ok(firstTargetFrame >= 180 && firstTargetFrame < 180 + cadence);
    const result = {
      navigation: snapshot.navigation,
      episode: snapshot.episode,
    };
    reference ??= result;
    assert.deepEqual(result, reference);
  }
});

test('equal physical motion preserves velocity and contact time, not next-control projection', () => {
  let reference;
  for (const cadence of [4, 8, 16]) {
    const ram = ramFixture();
    ram[0xf] = 1;
    ram[0x16] = 6;
    ram[0x87] = 200;
    ram[0xcf] = 208;
    ram[0xb6] = 1;
    const parser = new Telemetry(cadence);
    parser.sample(ram, 0);
    let snapshot;
    for (let frame = cadence; frame <= 32; frame += cadence) {
      ram[0x86] = 40 + frame;
      ram[0x87] = 200 - frame * 2;
      snapshot = parser.sample(ram, frame, 'right');
    }
    const enemy = snapshot.hazard.enemies[0];
    const result = {
      x: snapshot.player.x,
      velocityX: snapshot.trajectory.velocityX,
      relativeVelocity: enemy.relativeVelocity,
      contactInFrames: enemy.contactInFrames,
    };
    reference ??= result;
    assert.deepEqual(result, reference);
    assert.equal(result.velocityX, 1);
    assert.equal(result.relativeVelocity, -3);
    assert.equal(result.contactInFrames, 16);
    assert.equal(enemy.projectedDx, enemy.dx - 3 * cadence);
    assert.equal(
      snapshot.reaction_timing.collisionLookaheadFrames,
      cadence + 16,
    );
  }
});

test('grounded maze resets retain only alternative observed floor heights within this life', () => {
  const ram = ramFixture();
  ram[0x6d] = 2;
  ram[0x86] = 88;
  ram[0x71a] = 2;
  ram[0x71c] = 0;
  ram[0xce] = 176;
  ram.fill(0, 0x500, 0x6a0);
  ram[0x500 + 4 * 16 + 5] = 1;
  ram[0x500 + 4 * 16] = 1;
  ram[0x500 + 4 * 16 + 1] = 1;
  ram[0x500 + 4 * 16 + 4] = 1;
  ram[0x500 + 4 * 16 + 6] = 1;
  ram[0x500 + 11 * 16 + 5] = 1;
  ram[0x500 + 11 * 16 + 6] = 1;
  const parser = new Telemetry(16);
  ram[0x86] = 8;
  parser.sample(ram, 0);
  ram[0x86] = 88;
  parser.sample(ram, 16);
  ram[0x6d] = 0;
  ram[0x86] = 24;
  ram[0x71a] = 0;
  const snapshot = parser.sample(ram, 32, 'right', {
    mazeReset: { x: 604, feet: 208, grounded: true },
  });
  assert.deepEqual(snapshot.navigation.mazeRoute, {
    gateX: 604,
    failedFloorYs: [208],
    alternativeFloorYs: [96],
    alternativeFloors: [{ topY: 96, startX: 576, endX: 624 }],
  });
  parser.sample(ram, 48, 'jump', {
    mazeReset: { x: 604, feet: 96, grounded: false },
  });
  assert.deepEqual(parser.mazeRoute.alternativeFloorYs, [96]);
  ram[0x75a]--;
  assert.equal(parser.sample(ram, 64).navigation.mazeRoute, undefined);
  assert.equal(parser.observedFloors.get(96).has(576), false);
});

test('maze alternatives exclude internal solid-rectangle seams at the actual gate column', () => {
  const ram = ramFixture();
  ram[0x6d] = 2;
  ram[0x86] = 88;
  ram[0x71a] = 2;
  ram[0x71c] = 0;
  ram[0xce] = 176;
  ram.fill(0, 0x500, 0x6a0);
  for (const row of [4, 5, 6, 11]) {
    for (const column of [4, 5, 6, 7]) ram[0x500 + row * 16 + column] = 1;
  }
  for (const column of [4, 5, 6]) ram[0x500 + 7 * 16 + column] = 1;
  const parser = new Telemetry(16);
  const before = parser.sample(ram, 0);
  assert.ok(before.terrain.surfaces.some((surface) => surface.topY === 144));
  assert.equal(parser.observedFloors.get(144).has(608), false);
  ram[0x6d] = 0;
  ram[0x86] = 24;
  ram[0x71a] = 0;
  const after = parser.sample(ram, 16, 'right_run', {
    mazeReset: { x: 604, feet: 208, grounded: true },
  });
  assert.deepEqual(after.navigation.mazeRoute, {
    gateX: 604,
    failedFloorYs: [208],
    alternativeFloorYs: [96],
    alternativeFloors: [{ topY: 96, startX: 592, endX: 640 }],
  });
  ram[0x6d] = 2;
  ram[0x86] = 88;
  ram[0x71a] = 2;
  parser.sample(ram, 32);
  ram[0x6d] = 0;
  ram[0x86] = 24;
  ram[0x71a] = 0;
  const repeated = parser.sample(ram, 48, 'right_run', {
    mazeReset: { x: 604, feet: 96, grounded: true },
  });
  assert.deepEqual(repeated.navigation.mazeRoute.failedFloorYs, [208, 96]);
  assert.deepEqual(repeated.navigation.mazeRoute.alternativeFloors, []);
});

test('multi-checkpoint maze feedback never blames the last floor for an earlier failure', () => {
  const ram = ramFixture();
  ram[0x75f] = 6;
  ram[0x75c] = 3;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  parser.observedFloors.set(96, new Set([768, 784, 1024, 1040, 1280, 1296]));
  parser.observedFloors.set(160, new Set([1024, 1040]));
  parser.observedFloors.set(208, new Set([768, 784, 1024, 1040, 1280, 1296]));
  const sample = (frame, x, checked, correct, checkpoints, reset = false) => {
    ram[0x6d] = Math.floor(x / 256);
    ram[0x86] = x % 256;
    ram[0x6da] = checked;
    ram[0x6d9] = correct;
    return parser.sample(ram, frame, 'right_run', {
      mazeCheckpoints: checkpoints,
      ...(reset ? { mazeReset: { x: 1286, feet: 96, grounded: true } } : {}),
    });
  };
  const first = {
    page: 4,
    x: 774,
    ordinal: 1,
    correct: true,
    floorY: 208,
    sequenceEnded: false,
  };
  const second = {
    page: 5,
    x: 1029,
    ordinal: 2,
    correct: false,
    floorY: 208,
    sequenceEnded: false,
  };
  const third = {
    page: 6,
    x: 1286,
    ordinal: 3,
    correct: null,
    floorY: 96,
    sequenceEnded: true,
    sequenceCorrect: false,
  };
  sample(16, 790, 1, 1, [first]);
  sample(32, 1040, 2, 1, [second]);
  const reset = sample(48, 290, 0, 0, [third], true);
  assert.deepEqual(reset.navigation.mazeRoute.alternativeFloorYs, [208]);
  assert.deepEqual(
    reset.navigation.mazeFeedback.checkpoints[2].failedFloorYs,
    [],
  );
  const next = sample(64, 790, 1, 1, [first]);
  assert.equal(next.navigation.mazeRoute.checkpointPage, 5);
  assert.deepEqual(next.navigation.mazeRoute.alternativeFloorYs, [96, 160]);
  sample(80, 1040, 2, 1, [{ ...second, floorY: 160 }]);
  sample(96, 290, 0, 0, [third], true);
  const known = sample(112, 790, 1, 1, [first]);
  assert.deepEqual(known.navigation.mazeRoute.alternativeFloorYs, [96]);
  sample(128, 1040, 2, 2, [{ ...second, correct: true, floorY: 96 }]);
  sample(144, 290, 0, 0, [{ ...third, correct: false }], true);
  const last = sample(160, 1100, 2, 2, [
    first,
    { ...second, correct: true, floorY: 96 },
  ]);
  assert.equal(last.navigation.mazeRoute.checkpointPage, 6);
  assert.deepEqual(last.navigation.mazeRoute.alternativeFloorYs, [208]);
  ram[0x75a]--;
  const newLife = parser.sample(ram, 176);
  assert.equal(newLife.navigation.mazeFeedback, undefined);
  assert.equal(newLife.navigation.mazeRoute, undefined);
});

test('stalled climbing targets use the last grounded feet and clear on life change', () => {
  const ram = ramFixture();
  ram[0x500 + 4 * 16 + 5] = 1;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  assert.equal(parser.sample(ram, 179).navigation.climbFloors, undefined);
  const climbing = parser.sample(ram, 180).navigation;
  const targets = climbing.climbFloors;
  assert.ok(targets.some((floor) => floor.topY === 96));
  assert.equal(climbing.higherLandingY, 208);
  ram[0x1d] = 1;
  ram[0xce] = 32;
  const airborne = parser.sample(ram, 196).navigation;
  assert.deepEqual(airborne.climbFloors, targets);
  assert.equal(airborne.higherLandingY, 208);
  ram[0x75a]--;
  assert.equal(parser.sample(ram, 212).navigation.climbFloors, undefined);
  assert.equal(parser.sample(ram, 228).navigation.higherLandingY, undefined);
});

test('a sustained land stall can target the observed far side of a nearby gap', () => {
  const ram = ramFixture();
  ram[0x500 + 12 * 16 + 6] = 0;
  ram[0x500 + 12 * 16 + 7] = 0;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  assert.equal(parser.sample(ram, 179).navigation.runJumpTargetX, undefined);
  assert.equal(parser.sample(ram, 180).navigation.runJumpTargetX, 128);
  ram[0x704] = 1;
  assert.equal(parser.sample(ram, 196).navigation.runJumpTargetX, undefined);
});

test('non-tile support can target a higher landing without labeling moving platforms harmful', () => {
  const ram = ramFixture();
  ram[0x500 + 12 * 16 + 3] = 0;
  ram[0xf] = 1;
  ram[0x16] = 36;
  ram[0x87] = 48;
  ram[0xb6] = 1;
  ram[0xcf] = 224;
  const parser = new Telemetry(16);
  const initial = parser.sample(ram, 0);
  assert.equal(initial.reaction_timing.framesPerDecision, 8);
  assert.equal(initial.navigation.higherLandingY, 208);
  assert.equal(initial.hazard.enemies[0].name, 'moving_platform');
  assert.equal(initial.hazard.imminentCollision, false);
  ram[0x1d] = 1;
  ram[0xce] = 100;
  const airborne = parser.sample(ram, 16);
  assert.equal(airborne.navigation.higherLandingY, 208);
  assert.equal(airborne.reaction_timing.framesPerDecision, 8);
  ram[0x1d] = 0;
  ram[0xce] = 192;
  ram[0x86] = 80;
  const landed = parser.sample(ram, 32);
  assert.equal(landed.navigation.higherLandingY, undefined);
  assert.equal(landed.reaction_timing.framesPerDecision, 16);
});

test('an observed gap target survives preparation and new best positions until a forward landing', () => {
  const ram = ramFixture();
  ram[0x500 + 12 * 16 + 6] = 0;
  ram[0x500 + 12 * 16 + 7] = 0;
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  assert.equal(parser.sample(ram, 180).navigation.runJumpTargetX, 128);
  ram[0x86]++;
  const snapshot = parser.sample(ram, 196, 'right');
  assert.equal(snapshot.episode.stalledFrames, 0);
  assert.equal(snapshot.navigation.runJumpTargetX, 128);
  ram[0x86] -= 16;
  assert.equal(parser.sample(ram, 212, 'left').navigation.runJumpTargetX, 128);
  ram[0x86] = 128;
  ram[0x1d] = 1;
  ram[0xce] = 96;
  assert.equal(
    parser.sample(ram, 228, 'right_run_jump').navigation.runJumpTargetX,
    128,
  );
  ram[0x1d] = 0;
  ram[0xce] = 192;
  assert.equal(parser.sample(ram, 244).navigation.runJumpTargetX, undefined);
});

test('support cadence respects a smaller configured interval and clears on life or area changes', () => {
  for (const address of [0x75a, 0xe7]) {
    const ram = ramFixture();
    ram[0x500 + 12 * 16 + 3] = 0;
    assert.equal(
      new Telemetry(4).sample(ram, 0).reaction_timing.framesPerDecision,
      4,
    );
    const parser = new Telemetry(16);
    assert.equal(parser.sample(ram, 0).reaction_timing.framesPerDecision, 8);
    ram[0x1d] = 1;
    ram[0xce] = 96;
    ram[address]++;
    assert.equal(parser.sample(ram, 8).reaction_timing.framesPerDecision, 16);
  }
});

test('remembered gap targets never carry across a life or area change', () => {
  for (const address of [0x75a, 0xe7]) {
    const ram = ramFixture();
    ram[0x500 + 12 * 16 + 6] = 0;
    ram[0x500 + 12 * 16 + 7] = 0;
    const parser = new Telemetry(16);
    parser.sample(ram, 0);
    assert.equal(parser.sample(ram, 180).navigation.runJumpTargetX, 128);
    ram[address]++;
    assert.equal(parser.sample(ram, 196).navigation.runJumpTargetX, undefined);
  }
});

test('moving support over a gap can target lower forward ground before a stall', () => {
  const ram = ramFixture();
  for (let x = 2; x < 7; x++) ram[0x500 + 12 * 16 + x] = 0;
  const parser = new Telemetry(16);
  const supported = parser.sample(ram, 0);
  assert.equal(supported.navigation.runJumpTargetX, 112);
  ram[0x86] = 16;
  const preparation = parser.sample(ram, 8, 'left');
  assert.equal(parser.lastGrounded.spriteSupported, false);
  assert.equal(preparation.navigation.runJumpTargetX, 112);
  ram[0x1d] = 1;
  ram[0xce] = 96;
  const airborne = parser.sample(ram, 16, 'right_jump');
  assert.equal(airborne.navigation.runJumpTargetX, 112);
  ram[0x86] = 120;
  ram[0x1d] = 0;
  ram[0xce] = 192;
  assert.equal(parser.sample(ram, 32).navigation.runJumpTargetX, undefined);
});

test('nearby active springboards shorten decisions without being labeled collision hazards', () => {
  const ram = ramFixture();
  ram[0xf] = 1;
  ram[0x16] = 0x32;
  ram[0x87] = 56;
  ram[0xb6] = 1;
  ram[0xcf] = 208;
  let snapshot = new Telemetry(16).sample(ram, 0);
  assert.equal(snapshot.reaction_timing.framesPerDecision, 4);
  assert.equal(snapshot.hazard.enemies[0].name, 'springboard');
  assert.equal(snapshot.hazard.imminentCollision, false);
  assert.equal(
    new Telemetry(2).sample(ram, 0).reaction_timing.framesPerDecision,
    2,
  );
  ram[0x87] = 104;
  snapshot = new Telemetry(16).sample(ram, 0);
  assert.equal(snapshot.reaction_timing.framesPerDecision, 16);
  ram[0x87]--;
  assert.equal(
    new Telemetry(16).sample(ram, 0).reaction_timing.framesPerDecision,
    4,
  );
  ram[0xf] = 0;
  assert.equal(
    new Telemetry(16).sample(ram, 0).reaction_timing.framesPerDecision,
    16,
  );
});

test('blocked positions record factual failed movement and never survive life or area changes', () => {
  const ram = ramFixture();
  const parser = new Telemetry(16);
  parser.sample(ram, 0);
  let snapshot = parser.sample(ram, 16, 'noop');
  assert.deepEqual(snapshot.navigation.blockedPositions, []);
  snapshot = parser.sample(ram, 32, 'right_run');
  assert.deepEqual(
    snapshot.navigation.blockedPositions,
    [],
    'braking without a wall is not a blockage',
  );
  ram[0x500 + 11 * 16 + 3] = 0x54;
  snapshot = parser.sample(ram, 48, 'right_run');
  assert.deepEqual(snapshot.navigation.blockedPositions, [{ x: 40, y: 208 }]);
  ram[0x86]++;
  snapshot = parser.sample(ram, 64, 'right_run');
  assert.equal(snapshot.navigation.blockedPositions.length, 1);
  ram[0x86] -= 8;
  snapshot = parser.sample(ram, 80, 'left');
  assert.deepEqual(snapshot.navigation.blockedPositions, [{ x: 41, y: 208 }]);
  ram[0x75a]--;
  snapshot = parser.sample(ram, 96, 'noop');
  assert.deepEqual(snapshot.navigation.blockedPositions, []);
  parser.sample(ram, 112, 'right_run');
  ram[0xe7]++;
  snapshot = parser.sample(ram, 128, 'noop');
  assert.deepEqual(snapshot.navigation.blockedPositions, []);
});

test('a grounded leftward attempt against visible geometry also records a blockage', () => {
  const ram = ramFixture();
  ram[0x500 + 11 * 16 + 2] = 0x54;
  const parser = new Telemetry(16);
  ram[0x86] = 56;
  parser.sample(ram, 0);
  ram[0x86] = 40;
  const snapshot = parser.sample(ram, 16, 'left');
  assert.deepEqual(snapshot.navigation.blockedPositions, [{ x: 40, y: 208 }]);
});

test('landing against a wall records the blocked endpoint even after vertical motion', () => {
  const ram = ramFixture();
  const parser = new Telemetry(16);
  ram[0x1d] = 1;
  ram[0xce] = 180;
  parser.sample(ram, 0);
  ram[0x1d] = 0;
  ram[0xce] = 192;
  ram[0x500 + 11 * 16 + 3] = 0x54;
  const snapshot = parser.sample(ram, 16, 'right_run', { landed: true });
  assert.deepEqual(snapshot.navigation.blockedPositions, [{ x: 40, y: 208 }]);
  assert.ok(snapshot.navigation.climbFloors.length > 0);
  assert.equal(snapshot.navigation.higherLandingY, 208);
});
