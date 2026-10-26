import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { MarioEmulator, validateROM } from '../emulator.mjs';
import { Game } from '../game.mjs';
import { listen } from '../http.mjs';
import { ACTIONS, parseDecision } from '../policy.mjs';
import { createGameServer } from '../server.mjs';
import { answer, homebrewROM, ramFixture } from './fixtures.mjs';

function gameFor(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-jev-mario-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const applied = [];
  const game = new Game({
    logDirectory: directory,
    framesPerDecision: 8,
    continuousPlay: false,
    makeEmulator: () => ({
      ram: ramFixture(),
      frame: 0,
      hash: 'a'.repeat(64),
      pixels: Buffer.alloc(256 * 240 * 4),
      boot() {},
      release() {},
      forecast() {
        return null;
      },
      advance(action, frames) {
        applied.push(action);
        this.frame += frames;
        this.ram[0x86] += 8;
        return frames;
      },
    }),
    decide: async () => ({ ...parseDecision(answer()), latencyMs: 1 }),
    ...options,
  });
  return { game, applied, directory };
}

test('ROM header validation accepts regional flag and rejects invalid formats', () => {
  const rom = homebrewROM();
  assert.match(validateROM(rom), /^[a-f0-9]{64}$/);
  assert.throws(() => validateROM(rom.subarray(0, 100)), /ROM/);
  for (const [offset, byte] of [
    [0, 0],
    [4, 1],
    [5, 2],
    [6, 4],
    [6, 16],
    [7, 8],
    [9, 2],
    [10, 1],
  ]) {
    const invalid = Buffer.from(rom);
    invalid[offset] = byte;
    assert.throws(() => validateROM(invalid), /ROM/);
  }
});

test('water uses eight-frame model decisions and returns to the configured land interval', async (t) => {
  const { game, applied } = gameFor(t, { framesPerDecision: 16 });
  const make = game.makeEmulator;
  game.makeEmulator = () => {
    const emulator = make();
    emulator.ram[0x704] = 1;
    return emulator;
  };
  game.load(Buffer.from('test-only'));
  const horizons = [];
  game.emulator.forecast = (frames) => {
    horizons.push(frames);
    return null;
  };
  assert.equal(game.info().framesPerDecision, 8);
  assert.equal(game.info().configuredFramesPerDecision, 16);
  await game.step();
  assert.equal(game.emulator.frame, 8);
  game.emulator.ram[0x704] = 0;
  await game.step();
  assert.equal(game.info().framesPerDecision, 16);
  await game.step();
  assert.equal(game.emulator.frame, 32);
  assert.deepEqual(horizons, [8, 8, 16]);
  assert.deepEqual(applied, ['right_run', 'right_run', 'right_run']);
});

test('real JSNES executes original homebrew frames without any Nintendo ROM', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = emulator.ram[0x86];
  assert.equal(emulator.advance('right_run_jump', 8), 8);
  assert.equal(emulator.frame, 8);
  assert.equal(emulator.ram[0x86], (before + 8) % 256);
  assert.equal(emulator.nes.controllers[1].state[0], 0x41);
  assert.equal(emulator.nes.controllers[1].state[1], 0x41);
  assert.equal(emulator.nes.controllers[1].state[7], 0x41);
  assert.equal(emulator.pixels.length, 245760);
  assert.equal(emulator.pixels[3], 255);
  emulator.advance('down', 1);
  assert.equal(emulator.nes.controllers[1].state[5], 0x41);
  assert.equal(emulator.nes.controllers[1].state[0], 0x40);
  emulator.ram[0xe] = 11;
  assert.equal(emulator.advance('right', 8), 0);
  assert.throws(() => emulator.advance('not-an-action', 8), /Unknown action/);
});

test('springboard cadence reaches forecasts and actual actions without changing model choices', async (t) => {
  const { game, applied } = gameFor(t, { framesPerDecision: 16 });
  const make = game.makeEmulator;
  game.makeEmulator = () => {
    const emulator = make();
    emulator.ram[0xf] = 1;
    emulator.ram[0x16] = 0x32;
    emulator.ram[0x87] = 56;
    return emulator;
  };
  game.load(Buffer.from('test-only'));
  const horizons = [];
  game.emulator.forecast = (frames) => {
    horizons.push(frames);
    return null;
  };
  assert.equal(game.info().framesPerDecision, 4);
  await game.step();
  game.emulator.ram[0xf] = 0;
  await game.step();
  await game.step();
  assert.deepEqual(horizons, [4, 4, 16]);
  assert.equal(game.emulator.frame, 24);
  assert.deepEqual(applied, ['right_run', 'right_run', 'right_run']);
});

test('narrow-support cadence reaches forecasts and actual raw-choice actions', async (t) => {
  const { game, applied } = gameFor(t, { framesPerDecision: 16 });
  const make = game.makeEmulator;
  game.makeEmulator = () => {
    const emulator = make();
    emulator.ram[0x500 + 7 * 16 + 4] = 0xc4;
    emulator.ram[0x500 + 4 * 16 + 8] = 0x10;
    emulator.ram[0x500 + 4 * 16 + 9] = 0x11;
    return emulator;
  };
  game.load(Buffer.from('test-only'));
  game.telemetry.observedLoopCount = 1;
  const forecasts = [];
  game.emulator.forecast = (frames, options) => {
    forecasts.push({ frames, options });
    return null;
  };
  await game.step();
  assert.equal(game.info().framesPerDecision, 8);
  await game.step();
  assert.equal(game.emulator.frame, 24);
  assert.equal(forecasts[1].frames, 8);
  assert.equal(forecasts[1].options.configuredFrames, 16);
  assert.equal(forecasts[1].options.narrowSupports.length, 1);
  game.emulator.ram[0x500 + 4 * 16 + 8] = 0;
  await game.step();
  assert.equal(game.info().framesPerDecision, 16);
  await game.step();
  assert.deepEqual(
    forecasts.map(({ frames }) => frames),
    [16, 8, 8, 16],
  );
  assert.equal(game.emulator.frame, 48);
  assert.deepEqual(applied, [
    'right_run',
    'right_run',
    'right_run',
    'right_run',
  ]);
});

test('maze stepping candidates exclude lower rejected floors and the gate approach', async (t) => {
  const { game } = gameFor(t);
  game.load(Buffer.from('test-only'));
  let options;
  game.emulator.forecast = (_frames, input) => {
    options = input;
    return null;
  };
  game.snapshot.navigation.mazeRoute = {
    gateX: 500,
    failedFloorYs: [208],
    alternativeFloorYs: [96],
    alternativeFloors: [{ topY: 96, startX: 200, endX: 600 }],
  };
  game.snapshot.terrain.surfaces = [{ topY: 208, startX: 0, endX: 600 }];
  await game.step();
  assert.deepEqual(options.mazeSteppingFloors, []);
  game.snapshot.navigation.mazeRoute = {
    gateX: 500,
    failedFloorYs: [96, 160],
    alternativeFloorYs: [208],
    alternativeFloors: [{ topY: 208, startX: 200, endX: 600 }],
  };
  game.snapshot.terrain.surfaces = [
    { topY: 160, startX: 100, endX: 600 },
    { topY: 96, startX: 450, endX: 480 },
  ];
  await game.step();
  assert.deepEqual(options.mazeSteppingFloors, [
    { topY: 160, startX: 100, endX: 436 },
  ]);
});

test('action forecasts preserve an intermediate highest point rather than only endpoints', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const frame = emulator.nes.frame.bind(emulator.nes);
  emulator.nes.frame = () => {
    frame();
    emulator.ram[0xce] = emulator.frame === 1 ? 80 : 192;
  };
  emulator.advance('right_jump', 4);
  assert.equal(emulator.lastEvents.highestY, 96);
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  predictor.advance = function (_action, frames) {
    this.frame += frames;
    this.lastEvents = { highestY: frames === 16 ? 96 : 40 };
    return frames;
  };
  const forecast = emulator.forecast(16);
  assert.equal(forecast.moves.right_jump.highestY, 40);
  assert.ok(forecast.moves.right_jump.next[1] > 40);
  assert.ok(forecast.moves.right_jump.held[1] > 40);
});

test('boot rejects a title/loading state that only temporarily has player state 8', () => {
  const emulator = new MarioEmulator();
  emulator.nes.loadROM = () => {};
  emulator.nes.cpu.mem = ramFixture();
  emulator.nes.cpu.mem[0x772] = 1;
  emulator.nes.frame = () => {};
  assert.throws(() => emulator.boot(homebrewROM()), /playable SMB1/);
});

test('action forecasts use isolated emulator copies and match actual future frames', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = JSON.stringify(emulator.nes.toJSON());
  const pixels = Buffer.from(emulator.pixels);
  const x = emulator.ram[0x86];
  const forecast = emulator.forecast(16);
  assert.deepEqual(Object.keys(forecast.moves), Object.keys(ACTIONS));
  assert.equal(emulator.frame, 0);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  assert.deepEqual(emulator.pixels, pixels);
  emulator.advance('right_run_jump', 16);
  assert.equal(forecast.moves.right_run_jump.next[0], emulator.ram[0x86] - x);
  emulator.advance('right_run_jump', 44);
  assert.equal(forecast.moves.right_run_jump.held[0], emulator.ram[0x86] - x);
});

test('maze landing witnesses permit one future change and reject reset continuations', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = JSON.stringify(emulator.nes.toJSON());
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  let resets = false;
  let behind = false;
  let checkpointFails = false;
  predictor.advance = function (action, frames) {
    this.frame += frames;
    if (action === 'left') {
      this.ram[0xce] = 80;
      if (behind) this.ram[0x86] = emulator.ram[0x86] - 1;
    }
    this.lastEvents = {
      ...(checkpointFails && action === 'left'
        ? { mazeCheckpoints: [{ correct: false }] }
        : {}),
      ...(resets && action === 'left'
        ? { mazeReset: { x: 600, feet: 112, grounded: false } }
        : {}),
    };
    return frames;
  };
  const mazeFloors = [{ topY: 112, startX: 0, endX: 256 }];
  let forecast = emulator.forecast(16, { mazeFloors });
  assert.notEqual(forecast.moves.right.next[1] + 16, 112);
  assert.equal(forecast.moves.right.mazeLanding, true);
  assert.equal(
    emulator.forecast(16, { climbFloors: mazeFloors }).moves.right.climbLanding,
    true,
    'stair targets use the same isolated landing search',
  );
  assert.equal(
    emulator.forecast(16, { higherLandingY: 128 }).moves.right.climbLanding,
    true,
    'moving-platform goals use grounded predicted height rather than static tiles',
  );
  assert.throws(
    () => emulator.forecast(16, { higherLandingY: Number.NaN }),
    /higher landing target/,
  );
  assert.equal(
    emulator.forecast(16, {
      mazeFloors: [{ topY: 112, startX: 512, endX: 768 }],
    }).moves.right.mazeLanding,
    true,
    'forward stepping stones remain useful before the final connected segment',
  );
  const currentFeet = emulator.ram[0xce] + 32;
  assert.equal(
    emulator.forecast(16, {
      mazeFloors: [{ topY: currentFeet, startX: 512, endX: 768 }],
    }).moves.right.mazeLanding,
    false,
    'remaining on the disconnected current floor is not an intermediate route landing',
  );
  const withStepping = emulator.forecast(16, {
    mazeFloors: [{ topY: 208, startX: 512, endX: 768 }],
    mazeSteppingFloors: [{ topY: 112, startX: 0, endX: 256 }],
  });

  assert.equal(withStepping.moves.right.mazeLanding, true);
  assert.equal(
    withStepping.moves.right.mazeConnectedLanding,
    false,
    'a rejected gate height can be an observed intermediate step, never a valid gate landing',
  );
  behind = true;
  assert.equal(
    emulator.forecast(16, { mazeFloors }).moves.right.mazeLanding,
    true,
    'a backward landing on the connected gate floor is useful',
  );
  assert.equal(
    emulator.forecast(16, {
      mazeFloors: [{ topY: 112, startX: emulator.ram[0x86] + 8, endX: 256 }],
    }).moves.right.mazeLanding,
    false,
    'the same height on a disconnected earlier floor is not a route witness',
  );
  behind = false;
  resets = true;
  forecast = emulator.forecast(16, { mazeFloors });
  assert.equal(forecast.moves.right.mazeLanding, false);
  resets = false;
  checkpointFails = true;
  forecast = emulator.forecast(16, { mazeFloors });
  assert.equal(forecast.moves.left.mazeCheckpointFailedNext, true);
  assert.equal(forecast.moves.left.mazeLanding, false);
  assert.equal(forecast.moves.right.mazeLanding, false);
  assert.equal(forecast.moves.left.survivesWithOneReplan, true);
  assert.notEqual(forecast.moves.left.noSurvivingFollowup, true);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  assert.throws(
    () => emulator.forecast(16, { mazeFloors: [Number.NaN] }),
    /maze floor/,
  );
});

test('native multi-checkpoint feedback distinguishes local failure from aggregate reset', () => {
  for (const [
    beforePass,
    beforeCorrect,
    afterPass,
    afterCorrect,
    reset,
    correct,
    standing = true,
  ] of [
    [0, 0, 1, 1, false, true],
    [1, 1, 2, 1, false, false],
    [2, 1, 0, 0, true, null],
    [2, 2, 0, 0, true, false],
    [2, 2, 0, 0, false, true],
    [1, 1, 2, 1, false, false, false],
  ]) {
    let reference;
    for (const cadence of [4, 8, 16]) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      emulator.ram[0x75f] = 6;
      emulator.ram[0x75c] = 3;
      emulator.ram[0x6d] = 5;
      emulator.ram[0x725] = 6;
      emulator.ram[0x6da] = beforePass;
      emulator.ram[0x6d9] = beforeCorrect;
      let frame = 0;
      emulator.nes.frame = () => {
        if (++frame !== 2) return;
        emulator.ram[0x6da] = afterPass;
        emulator.ram[0x6d9] = afterCorrect;
        if (reset) emulator.ram[0x6d] = 1;
        if (!standing) emulator.ram[0x1d] = 1;
      };
      emulator.advance('right', cadence);
      assert.equal(emulator.lastEvents.mazeCheckpoints.length, 1);
      const feedback = emulator.lastEvents.mazeCheckpoints[0];
      assert.equal(feedback.correct, correct);
      assert.equal(feedback.ordinal, beforePass + 1);
      assert.equal(feedback.floorY, standing ? emulator.ram[0xce] + 32 : null);
      assert.equal(feedback.sequenceCorrect, beforePass === 2 ? !reset : null);
      reference ??= feedback;
      assert.deepEqual(feedback, reference);
    }
  }
});

test('climbing can require preparation, jumping, and a final release within four intervals', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = JSON.stringify(emulator.nes.toJSON());
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  predictor.advance = function (action, frames) {
    this.frame += frames;
    if (this.frame === 16 && action === 'left') this.ram[0x701] = 1;
    else if (this.ram[0x701] === 1 && action === 'left_jump') {
      this.ram[0x702] += frames;
      this.ram[0x1d] = 1;
    } else if (
      this.ram[0x701] === 1 &&
      this.ram[0x702] === 32 &&
      action === 'right'
    ) {
      this.ram[0x1d] = 0;
      this.ram[0xce] = 80;
    } else this.ram[0x701] = 0;
    this.lastEvents = {};
    return frames;
  };
  const forecast = emulator.forecast(16, { higherLandingY: 128 });
  assert.equal(forecast.moves.left.climbLanding, true);
  assert.equal(forecast.moves.right.climbLanding, false);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  assert.equal(emulator.frame, 0);
});

test('a jump witness may delay its one release until after landing', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = JSON.stringify(emulator.nes.toJSON());
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  predictor.advance = function (action, frames) {
    this.frame += frames;
    if (action.includes('jump')) {
      this.ram[0x701] += frames;
      this.ram[0x1d] = this.ram[0x701] >= 48 ? 0 : 1;
    } else if (this.ram[0x701] < 48) {
      this.ram[0x0e] = 11;
    } else {
      this.ram[0x1d] = 0;
    }
    this.lastEvents = {};
    return frames;
  };
  const forecast = emulator.forecast(16);
  assert.equal(forecast.moves.jump.jumpReadyNext, false);
  assert.equal(forecast.moves.jump.survivesWithOneReplan, true);
  assert.equal(forecast.readyStateLookaheadFrames, 64);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
});

test('bounded run-jump probes never advance live play and reject invalid targets', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const before = JSON.stringify(emulator.nes.toJSON());
  const forecast = emulator.forecast(16, { runJumpTargetX: 60 });
  assert.equal(forecast.runJumpLookaheadFrames, 172);
  assert.equal(forecast.moves.left.runJumpLanding, true);
  assert.equal(emulator.frame, 0);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  assert.throws(
    () => emulator.forecast(16, { runJumpTargetX: Number.NaN }),
    /run-jump landing target/,
  );
});

test('short controls retain longer bounded continuation windows without inventing a trap', () => {
  let heldAtSixtyFrames;
  for (const frames of [3, 4, 8, 16]) {
    const emulator = new MarioEmulator();
    emulator.boot(homebrewROM());
    const before = JSON.stringify(emulator.nes.toJSON());
    const predictor = new MarioEmulator();
    predictor.nes.loadROM(emulator.nes.romData);
    emulator.predictor = predictor;
    let furthestFrame = 0;
    predictor.advance = function (action, duration) {
      this.frame += duration;
      furthestFrame = Math.max(furthestFrame, this.frame);
      this.ram[0x701] += duration;
      this.ram[0x0e] = action === 'right_run' && this.ram[0x701] >= 60 ? 11 : 8;
      this.ram[0x1d] = action === 'right_run' || this.ram[0x701] < 32 ? 1 : 0;
      this.lastEvents = {};
      return duration;
    };
    const forecast = emulator.forecast(frames);
    const continuationFrames = frames * Math.ceil(16 / frames);
    assert.equal(forecast.frames, frames);
    assert.equal(forecast.continuationFrames, continuationFrames);
    assert.equal(continuationFrames % frames, 0);
    assert.equal(forecast.trapLookaheadFrames, frames * 3);
    assert.equal(
      forecast.readyStateLookaheadFrames,
      frames + 3 * continuationFrames,
    );
    assert.equal(
      forecast.readyStateSurvivalLookaheadFrames,
      frames + 5 * continuationFrames,
    );
    assert.equal(forecast.moves.right_run.survivesWithOneReplan, true);
    assert.equal(forecast.moves.right_run.noSurvivingFollowup, undefined);
    const held = Object.fromEntries(
      Object.entries(forecast.moves).map(([action, move]) => [
        action,
        move.held,
      ]),
    );
    heldAtSixtyFrames ??= held;
    assert.deepEqual(held, heldAtSixtyFrames);
    assert.ok(
      furthestFrame <= Math.max(60, forecast.readyStateSurvivalLookaheadFrames),
    );
    assert.equal(emulator.frame, 0);
    assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  }
});

test('initial and short-cadence ready boundaries share physically bounded survival verification', () => {
  for (const frames of [4, 8, 16]) {
    for (const outcome of ['ready', 'dead', 'airborne']) {
      for (const startFrame of [0, 16]) {
        const emulator = new MarioEmulator();
        emulator.boot(homebrewROM());
        emulator.ram[0x1d] = startFrame ? 0 : 1;
        emulator.ram[0x701] = startFrame;
        emulator.frame = startFrame;
        const before = JSON.stringify(emulator.nes.toJSON());
        const predictor = new MarioEmulator();
        predictor.nes.loadROM(emulator.nes.romData);
        emulator.predictor = predictor;
        let furthestFrame = startFrame;
        predictor.advance = function (action, duration) {
          let elapsed = 0;
          for (; elapsed < duration && this.ram[0x0e] !== 11; elapsed++) {
            this.frame++;
            furthestFrame = Math.max(furthestFrame, this.frame);
            const time = ++this.ram[0x701];
            const valid =
              time <= 16
                ? action === 'right_run'
                : time <= 32
                  ? action.includes('jump')
                  : action === 'noop';
            if (!valid || (outcome === 'dead' && time >= 60))
              this.ram[0x0e] = 11;
            this.ram[0x1d] =
              time === 16 || (time > 32 && outcome !== 'airborne') ? 0 : 1;
          }
          this.lastEvents = {};
          return elapsed;
        };
        const forecast = emulator.forecast(frames);
        const move = forecast.moves[startFrame ? 'jump' : 'right_run'];
        assert.equal(move.held[2], 'dead');
        assert.equal(
          move.survivesWithOneReplan,
          outcome === 'ready',
          `${frames}-frame controls from frame ${startFrame} must retain a ready endpoint, not just an alive ${outcome} pose`,
        );
        if (outcome === 'airborne')
          assert.equal(move.noSurvivingFollowup, undefined);
        assert.ok(
          furthestFrame <=
            startFrame +
              Math.max(60, forecast.readyStateSurvivalLookaheadFrames),
        );
        assert.equal(emulator.frame, startFrame);
        assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
      }
    }
  }
});

test('run-jump witnesses accept viable intermediate landings, not trapped ones, within the same budget', () => {
  for (const trapped of [false, true]) {
    const emulator = new MarioEmulator();
    emulator.boot(homebrewROM());
    const before = JSON.stringify(emulator.nes.toJSON());
    const predictor = new MarioEmulator();
    predictor.nes.loadROM(emulator.nes.romData);
    emulator.predictor = predictor;
    let furthestFrame = 0;
    predictor.advance = function (action, frames) {
      this.frame += frames;
      furthestFrame = Math.max(furthestFrame, this.frame);
      if (trapped && this.ram[0x701] === 16) this.ram[0x0e] = 11;
      if (action === 'right_run_jump') this.ram[0x701] += frames;
      if (this.ram[0x701] === 16) {
        this.ram[0x86] = 80;
        this.ram[0x1d] = 0;
      } else if (this.ram[0x701] > 16) {
        this.ram[0x0e] = 11;
      }
      this.lastEvents = {};
      return frames;
    };
    const forecast = emulator.forecast(16, { runJumpTargetX: 80 });
    assert.equal(forecast.moves.right_run.runJumpLanding, !trapped);
    assert.equal(forecast.runJumpLookaheadFrames, 172);
    assert.ok(furthestFrame <= 172);
    assert.equal(emulator.frame, 0);
    assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  }
});

function ramOnlyRunJumpPredictor(emulator) {
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  // These synthetic advance functions read only RAM, not emulator internals.
  predictor.nes.toJSON = () => ({
    cpu: { mem: predictor.ram.slice(0, 2048) },
  });
  predictor.nes.fromJSON = (snapshot) => {
    predictor.nes.cpu.mem = snapshot.cpu.mem.slice(0, 2048);
  };
  emulator.predictor = predictor;
  return predictor;
}

test('narrow support needs permanent same-path landing and full physical stability at 4/8/16 frames', () => {
  for (const frames of [4, 8, 16]) {
    for (const ending of [
      'ready',
      'short',
      'transient',
      'dead',
      'wrong-area',
      'no-pipe',
      'spring-cadence',
    ]) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      const tile = 0x500 + 7 * 16 + 4;
      emulator.ram[tile] = 0x23;
      emulator.ram[0x500 + 4 * 16 + 8] = 0x10;
      emulator.ram[0x500 + 4 * 16 + 9] = 0x11;
      const before = JSON.stringify(emulator.nes.toJSON());
      const predictor = ramOnlyRunJumpPredictor(emulator);
      let furthestFrame = 0;
      predictor.advance = function (action, duration) {
        if (!this.ram[0x701]) this.ram[0x706] = action === 'noop' ? 1 : 2;
        this.frame += duration;
        furthestFrame = Math.max(furthestFrame, this.frame);
        this.ram[0x701] += duration;
        const elapsed = this.ram[0x701];
        const targetPath = this.ram[0x706] === 1;
        const landed = elapsed >= 32 && targetPath;
        this.ram[tile] = ending === 'transient' ? 0x23 : 0xc4;
        this.ram[0x86] = 64;
        this.ram[0xce] = landed ? 112 : targetPath ? 160 : 192;
        this.ram[0x1d] = landed || !targetPath ? 0 : 1;
        if (ending === 'short' && targetPath && elapsed >= 56) {
          this.ram[0xce] = elapsed >= 64 ? 192 : 160;
          this.ram[0x1d] = elapsed >= 64 ? 0 : 2;
        }
        if (ending === 'dead' && targetPath && elapsed >= 56)
          this.ram[0x0e] = 11;
        if (ending === 'wrong-area' && landed) this.ram[0xe7] = 1;
        if (ending === 'no-pipe' && landed) this.ram[0x500 + 4 * 16 + 8] = 0;
        if (ending === 'spring-cadence' && landed) {
          this.ram[0xf] = 1;
          this.ram[0x16] = 0x32;
          this.ram[0x87] = 64;
        }
        this.lastEvents = {};
        return duration;
      };
      const forecast = emulator.forecast(frames, {
        narrowSupports: [{ startX: 64, endX: 80, topY: 144 }],
      });
      const expected =
        ending === 'ready' || (ending === 'spring-cadence' && frames === 4);
      assert.equal(forecast.moves.noop.supportLanding, expected);
      assert.equal(
        forecast.moves.left.supportLanding,
        false,
        'cannot borrow the noop first-action path',
      );
      if (expected) assert.equal(forecast.moves.noop.supportLandingFrames, 64);
      else assert.equal(forecast.moves.noop.supportLandingFrames, undefined);
      if (ending === 'short')
        assert.equal(forecast.moves.noop.noSurvivingFollowup, undefined);
      assert.equal(forecast.narrowSupportLookaheadFrames, frames + 80);
      assert.equal(
        forecast.narrowSupportPreparationLookaheadFrames,
        frames + 48,
      );
      assert.equal(forecast.narrowSupportValidationFrames, 32);
      assert.equal(forecast.narrowSupportBeamWidth, 16);
      assert.equal(forecast.narrowSupportSamplingFrames, Math.min(frames, 8));
      assert.equal(Object.keys(forecast.moves).length, 9);
      assert.ok(furthestFrame <= Math.max(60, frames + 80));
      assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
      assert.equal(emulator.frame, 0);
    }
  }
});

test('hidden-block activation needs permanent support and same-path ready continuation at each cadence', () => {
  for (const frames of [4, 8, 16]) {
    for (const ending of [
      'ready',
      'airborne',
      'dead',
      'transient',
      'wrong-area',
    ]) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      const tile = 0x500 + 7 * 16 + 4;
      emulator.ram[tile] = 0x5f;
      const before = JSON.stringify(emulator.nes.toJSON());
      const predictor = ramOnlyRunJumpPredictor(emulator);
      let furthestFrame = 0;
      predictor.advance = function (action, duration) {
        this.frame += duration;
        furthestFrame = Math.max(furthestFrame, this.frame);
        this.ram[0x701] += duration;
        if (action.includes('jump')) this.ram[0x702] += duration;
        if (this.ram[0x702] >= 16) {
          this.ram[tile] =
            this.ram[0x701] >= 32 && ending !== 'transient' ? 0xc4 : 0x23;
          if (ending === 'wrong-area' && this.ram[0x701] >= 32)
            this.ram[0xe7] = 1;
        }
        this.ram[0x1d] =
          this.ram[0x701] < 32 ||
          (ending === 'airborne' && this.ram[0x701] >= 60)
            ? 1
            : 0;
        if (ending === 'dead' && this.ram[0x701] >= 60) this.ram[0x0e] = 11;
        this.lastEvents = {};
        return duration;
      };
      const forecast = emulator.forecast(frames, {
        hiddenBlocks: [{ x: 64, y: 144 }],
      });
      assert.equal(forecast.moves.jump.revealsHiddenBlock, ending === 'ready');
      assert.equal(forecast.moves.noop.revealsHiddenBlock, ending === 'ready');
      if (ending === 'ready')
        assert.equal(forecast.moves.jump.hiddenBlockReadyFrames, 32);
      else assert.equal(forecast.moves.jump.hiddenBlockReadyFrames, undefined);
      if (ending === 'airborne')
        assert.equal(forecast.moves.jump.noSurvivingFollowup, undefined);
      assert.ok(furthestFrame <= Math.max(60, frames + 5 * 16));
      assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
      assert.equal(emulator.frame, 0);
      assert.throws(
        () => emulator.forecast(frames, { hiddenBlocks: [{ x: 64, y: 160 }] }),
        /Invalid observed hidden block/,
      );
    }
  }
});

test('hidden-block preparation can rearm held A before its witnessed jump', () => {
  for (const frames of [4, 8, 16]) {
    const emulator = new MarioEmulator();
    emulator.boot(homebrewROM());
    const tile = 0x500 + 7 * 16 + 4;
    emulator.ram[tile] = 0x5f;
    emulator.ram[0x703] = 1;
    const before = JSON.stringify(emulator.nes.toJSON());
    const predictor = ramOnlyRunJumpPredictor(emulator);
    predictor.advance = function (action, duration) {
      this.frame += duration;
      this.ram[0x701] += duration;
      if (action.includes('jump')) {
        if (!this.ram[0x703]) this.ram[0x706] = 1;
        this.ram[0x703] = 1;
        if (this.ram[0x706]) this.ram[0x702] += duration;
      } else {
        this.ram[0x703] = 0;
        this.ram[0x706] = 0;
      }
      if (this.ram[0x702] >= 16) this.ram[tile] = 0xc4;
      this.ram[0x1d] = action.includes('jump') ? 1 : 0;
      this.lastEvents = {};
      return duration;
    };
    const forecast = emulator.forecast(frames, {
      hiddenBlocks: [{ x: 64, y: 144 }],
    });
    assert.equal(forecast.moves.jump.revealsHiddenBlock, false);
    assert.equal(forecast.moves.left.revealsHiddenBlock, true);
    assert.ok(forecast.moves.left.hiddenBlockReadyFrames <= frames + 48);
    assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
    assert.equal(emulator.frame, 0);
  }
});

test('prepared pipe progress uses real first cadence and rejects backward, lethal, or skipped-level destinations', () => {
  for (const frames of [4, 8, 16]) {
    for (const destination of [
      'forward',
      'different-area',
      'backward',
      'dead',
      'warp',
    ]) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      const before = JSON.stringify(emulator.nes.toJSON());
      const predictor = ramOnlyRunJumpPredictor(emulator);
      predictor.advance = function (action, duration) {
        if (this.ram[0x0e] === 3) return 0;
        this.frame += duration;
        this.ram[0x701] += duration;
        if (action === 'down' && this.ram[0x701] >= 32) this.ram[0x0e] = 3;
        this.lastEvents = {};
        return duration;
      };
      predictor.advanceTransition = function () {
        this.frame += 16;
        this.ram[0x0e] = destination === 'dead' ? 11 : 8;
        if (destination === 'dead') this.ram[0x770] = 3;
        this.ram[0x86] = destination === 'forward' ? 120 : 20;
        if (destination === 'different-area') this.ram[0xe7]++;
        if (destination === 'warp') this.ram[0x75c] += 2;
        return 16;
      };
      const forecast = emulator.forecast(frames, { probePipeEntry: true });
      assert.equal(forecast.frames, frames);
      assert.equal(forecast.pipeEntryLookaheadFrames, frames + 48 + 60);
      assert.equal(forecast.pipeAutomaticFrameLimit, 6000);
      assert.equal(
        forecast.moves.right.pipeProgress,
        ['forward', 'different-area'].includes(destination),
      );
      assert.equal(
        Boolean(forecast.moves.down.returnsWithinArea),
        destination === 'backward',
      );
      if (forecast.moves.right.pipeProgress)
        assert.ok(
          forecast.moves.right.pipeEntryFrames > 0 &&
            forecast.moves.right.pipeEntryFrames <=
              forecast.pipeEntryLookaheadFrames,
        );
      assert.equal(emulator.frame, 0);
      assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
    }
  }
});

test('run-jump horizon landings require a ready physical continuation at every cadence', () => {
  for (const frames of [4, 8, 16]) {
    for (const endpoint of ['ready', 'airborne', 'dead']) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      const before = JSON.stringify(emulator.nes.toJSON());
      const predictor = ramOnlyRunJumpPredictor(emulator);
      let furthestFrame = 0;
      predictor.advance = function (action, duration) {
        this.frame += duration;
        furthestFrame = Math.max(furthestFrame, this.frame);
        if (action === 'right_run_jump' || this.ram[0x701])
          this.ram[0x701] += duration;
        const elapsed = this.ram[0x701];
        this.ram[0x86] = elapsed >= 60 ? 80 : 40;
        this.ram[0x1d] =
          elapsed === 60 || (elapsed > 60 && endpoint === 'ready') ? 0 : 1;
        if (elapsed > 60 && endpoint === 'dead') this.ram[0x0e] = 11;
        this.lastEvents = {};
        return duration;
      };
      const forecast = emulator.forecast(frames, { runJumpTargetX: 80 });
      assert.equal(
        forecast.moves.right_run.runJumpLanding,
        endpoint === 'ready',
        `${frames}-frame control must not accept a ${endpoint} continuation`,
      );
      assert.ok(furthestFrame <= forecast.runJumpLookaheadFrames);
      assert.equal(emulator.frame, 0);
      assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
    }
  }
});

test('run-jump witnesses can release before landing without borrowing another path', () => {
  for (const frames of [4, 8, 16]) {
    for (const canBrake of [false, true]) {
      const emulator = new MarioEmulator();
      emulator.boot(homebrewROM());
      const before = JSON.stringify(emulator.nes.toJSON());
      const predictor = ramOnlyRunJumpPredictor(emulator);
      let furthestFrame = 0;
      predictor.advance = function (action, duration) {
        for (let n = 0; n < duration; n++) {
          this.frame++;
          furthestFrame = Math.max(furthestFrame, this.frame);
          if (action === 'right_run_jump' || this.ram[0x701]) this.ram[0x701]++;
          const elapsed = this.ram[0x701];
          if (elapsed > 32 && (!canBrake || action !== 'left'))
            this.ram[0x0e] = 11;
          this.ram[0x86] = elapsed >= 48 ? 80 : 40;
          this.ram[0x1d] = elapsed >= 48 ? 0 : 1;
        }
        this.lastEvents = {};
        return duration;
      };
      const forecast = emulator.forecast(frames, { runJumpTargetX: 80 });
      assert.equal(forecast.moves.right_run.runJumpLanding, canBrake);
      assert.ok(furthestFrame <= forecast.runJumpLookaheadFrames);
      assert.equal(emulator.frame, 0);
      assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
    }
  }
});

test('a short ready pose needs longer continuation evidence without becoming a proven trap', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM({ deathX: 80 }));
  emulator.ram[0x700] = 1;
  emulator.ram[0x86] = 40;
  const before = JSON.stringify(emulator.nes.toJSON());
  const forecast = emulator.forecast(4);
  assert.equal(forecast.moves.right_run.jumpReadyNext, true);
  assert.equal(forecast.moves.right_run.held[2], 'dead');
  assert.equal(forecast.moves.right_run.survivesWithOneReplan, false);
  assert.equal(forecast.moves.right_run.noSurvivingFollowup, undefined);
  assert.equal(forecast.trapLookaheadFrames, 12);
  assert.equal(forecast.readyStateSurvivalLookaheadFrames, 84);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
});

test('forecasts detect traps across two follow-up intervals without changing live state', () => {
  const trapped = new MarioEmulator();
  trapped.boot(homebrewROM({ deathX: 60 }));
  trapped.ram[0x700] = 1;
  trapped.ram[0x86] = 40;
  const trappedMove = trapped.forecast(16).moves.right_run;
  assert.notEqual(trappedMove.next[2], 'dead');
  assert.equal(trappedMove.held[2], 'dead');
  assert.equal(trappedMove.noSurvivingFollowup, true);
  assert.equal(
    trappedMove.survivesWithOneReplan,
    false,
    'a ready pose with a fatal hold needs an actual ready continuation',
  );

  const delayed = new MarioEmulator();
  delayed.boot(homebrewROM({ deathX: 80 }));
  delayed.ram[0x700] = 1;
  delayed.ram[0x86] = 40;
  const before = JSON.stringify(delayed.nes.toJSON());
  const forecast = delayed.forecast(16);
  assert.equal(forecast.trapLookaheadFrames, 48);
  assert.equal(forecast.readyStateLookaheadFrames, 64);
  assert.equal(forecast.readyStateSurvivalLookaheadFrames, 96);
  assert.equal(forecast.moves.right_run.noSurvivingFollowup, true);
  assert.equal(JSON.stringify(delayed.nes.toJSON()), before);
  assert.equal(delayed.frame, 0);

  const viable = new MarioEmulator();
  viable.boot(homebrewROM({ deathX: 100 }));
  viable.ram[0x700] = 1;
  viable.ram[0x86] = 40;
  const viableMove = viable.forecast(16).moves.right_run;
  assert.notEqual(viableMove.next[2], 'dead');
  assert.equal(viableMove.held[2], 'dead');
  assert.equal(viableMove.noSurvivingFollowup, undefined);
  assert.equal(
    viableMove.survivesWithOneReplan,
    false,
    'a later ready pose must not terminate at an already-doomed boundary',
  );
  viable.ram[0x1d] = 1;
  const airborne = viable.forecast(16).moves.right_run;
  assert.equal(airborne.survivesWithOneReplan, false);
  assert.equal(
    airborne.noSurvivingFollowup,
    undefined,
    'no ready-state witness is not proof of a trap',
  );
  viable.ram[0x704] = 1;
  const swimming = viable.forecast(16);
  assert.equal(swimming.moves.right_run.survivesWithOneReplan, false);
  assert.equal(swimming.moves.right_run.jumpReadyNext, true);
  assert.equal(swimming.moves.right_run_jump.jumpReadyNext, false);
});

test('a survival witness permits a future change instead of requiring a safe uninterrupted hold', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  emulator.ram[0x86] = 40;
  emulator.ram[0x1d] = 1;
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  predictor.advance = function (action, frames) {
    this.frame += frames;
    if (action !== 'left') this.ram[0x86] += frames;
    else this.ram[0x1d] = 0;
    if (this.ram[0x86] >= 80) this.ram[0xe] = 11;
    this.lastEvents = { headBump: false, landed: false };
    return frames;
  };
  const before = JSON.stringify(emulator.nes.toJSON());
  const move = emulator.forecast(16).moves.right_run;
  assert.notEqual(move.next[2], 'dead');
  assert.equal(move.held[2], 'dead');
  assert.equal(move.survivesWithOneReplan, true);
  assert.equal(move.noSurvivingFollowup, undefined);
  assert.equal(emulator.frame, 0);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
});

test('forecasts identify pipe entry that only occurs in the held horizon', () => {
  const emulator = new MarioEmulator();
  emulator.boot(homebrewROM());
  const predictor = new MarioEmulator();
  predictor.nes.loadROM(emulator.nes.romData);
  emulator.predictor = predictor;
  const advance = predictor.advance;
  let transitionState = 2;
  predictor.advance = function (action, frames) {
    const count = advance.call(this, action, frames);
    if (this.frame >= 48) this.ram[0xe] = transitionState;
    return count;
  };
  predictor.advanceTransition = function () {
    this.ram[0xe] = 8;
    this.ram[0x75f] = 1;
    this.ram[0x75c] = 0;
    this.frame++;
    return 1;
  };
  const before = JSON.stringify(emulator.nes.toJSON());
  const forecast = emulator.forecast(16);
  assert.notEqual(forecast.moves.right.next[2], 'transition');
  assert.equal(forecast.moves.right.held[2], 'transition');
  assert.equal(forecast.moves.right.entersArea, true);
  assert.deepEqual(forecast.moves.right.areaDestination, [2, 1]);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  predictor.advanceTransition = function (frames) {
    this.frame += frames;
    return frames;
  };
  assert.throws(() => emulator.forecast(16), /6000 automatic frames/);
  transitionState = 4;
  assert.equal(emulator.forecast(16).moves.right.entersArea, false);
  assert.equal(emulator.frame, 0);
});

test('neutral transition frames release buttons and stop before playable input', () => {
  const emulator = new MarioEmulator();
  emulator.nes.cpu.mem = ramFixture();
  emulator.ram[0xe] = 3;
  emulator.nes.buttonDown(1, 5);
  let frames = 0;
  emulator.nes.frame = () => {
    frames++;
    assert.equal(emulator.nes.controllers[1].state[5], 0x40);
    if (frames === 4) emulator.ram[0xe] = 8;
  };
  assert.equal(emulator.advance('down', 16), 0);
  assert.equal(emulator.advanceTransition(), 4);
  assert.equal(emulator.frame, 4);
  assert.equal(
    emulator.advanceTransition(),
    0,
    'never play controllable frames without a model choice',
  );
  assert.throws(() => emulator.advanceTransition(0), /frame count/);
});

test('intermediate clear continues through a logged neutral transition, then resumes model choices', async (t) => {
  const { game, applied } = gameFor(t);
  game.load(Buffer.from('test-only'));
  const advance = game.emulator.advance;
  game.emulator.advance = function (action, frames) {
    const result = advance.call(this, action, frames);
    if (game.count === 0) {
      this.ram[0xe] = 4;
      this.ram[0x1d] = 3;
      this.ram[0xf] = 1;
      this.ram[0x16] = 0x31;
    }
    return result;
  };
  game.emulator.advanceTransition = function () {
    this.frame += 40;
    this.ram = ramFixture();
    this.ram[0x75c] = 1;
    return 40;
  };
  await game.step();
  assert.equal(game.status, 'transitioning');
  assert.deepEqual(game.snapshot.campaign.completedLevels, ['1-1']);
  assert.equal(game.snapshot.episode.terminal, null);
  await game.step();
  assert.equal(game.count, 1, 'cutscenes do not consume model decisions');
  assert.equal(game.snapshot.campaign.currentLevel, '1-2');
  assert.equal(game.snapshot.trajectory.velocityX, null);
  assert.equal(game.trace.length, 0);
  await game.step();
  assert.equal(game.count, 2);
  assert.deepEqual(applied, ['right_run', 'right_run']);
  const events = readFileSync(game.logPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    events.filter((event) => event.kind === 'automatic-transition').length,
    1,
  );
  assert.equal(events.filter((event) => event.kind === 'choice').length, 2);
  assert.equal(game.experience, null);
});

test('automatic transitions are bounded and restart resets campaign progress', async (t) => {
  const { game, applied } = gameFor(t);
  game.load(Buffer.from('test-only'));
  game.emulator.ram[0xe] = 3;
  game.snapshot = game.telemetry.sample(game.emulator.ram, 1);
  game.transitionFrames = 6000;
  await assert.rejects(game.step(), /6000 frames/);
  assert.equal(game.status, 'error');
  assert.deepEqual(applied, []);
  game.telemetry.completedLevels.add('1-1');
  game.restart();
  assert.deepEqual(game.snapshot.campaign.completedLevels, []);
  assert.equal(game.transitionFrames, 0);
});

test('reaching the final castle after skipping levels is an explicit failure', async (t) => {
  const { game } = gameFor(t);
  game.load(Buffer.from('test-only'));
  game.emulator.ram[0x75f] = 7;
  game.emulator.ram[0x75c] = 3;
  game.snapshot = game.telemetry.sample(game.emulator.ram, 1);
  game.emulator.advance = function (_action, frames) {
    this.ram[0x770] = 2;
    this.frame += frames;
    return frames;
  };
  await assert.rejects(game.step(), /only 1\/32/);
  assert.equal(game.status, 'error');
  assert.equal(game.snapshot.episode.terminal, 'incomplete');
});

test('missing ROM, exact action, decision logging, limits and explicit restart', async (t) => {
  const { game, applied } = gameFor(t, {
    maxDecisions: 1,
    decide: async () => ({ ...parseDecision(answer('left')), latencyMs: 1 }),
  });
  await assert.rejects(game.step(), /Missing ROM/);
  game.load(Buffer.from('test-only'));
  await game.step();
  assert.deepEqual(applied, ['left']);
  assert.equal(game.status, 'limit');
  const events = readFileSync(game.logPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['start', 'request', 'choice', 'applied', 'transition'],
  );
  assert.equal(events[3].frames, 8);
  assert.equal(events[3].frame, 8);
  assert.equal(events[4].state.episode.frame, 8);
  assert.equal(game.info().pendingApplied, null);
  const runId = game.runId;
  await assert.rejects(game.step(), /ended/);
  game.restart();
  assert.notEqual(game.runId, runId);
  assert.equal(game.count, 0);
  assert.equal(game.running, false);
});

test('cancellation discards even an upstream response ignoring AbortSignal', async (t) => {
  let resolve;
  const { game, applied } = gameFor(t, {
    decide: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  game.load(Buffer.from('test-only'));
  const pending = game.step();
  assert.equal(game.busy, true);
  assert.equal(game.emulator.frame, 0, 'simulation must freeze while waiting');
  assert.throws(() => game.restart(), /Pause/);
  await assert.rejects(game.step(), /in flight/);
  game.pause();
  resolve({ ...parseDecision(answer()), latencyMs: 1 });
  await pending;
  assert.deepEqual(applied, []);
  assert.equal(game.count, 0);
  assert.equal(game.status, 'paused');
});

test('model and log failures stop the agent without taking fallback actions', async (t) => {
  const { game, applied } = gameFor(t, {
    decide: async () => {
      throw new Error('invalid answer');
    },
  });
  game.load(Buffer.from('test-only'));
  await assert.rejects(game.step(), /invalid answer/);
  assert.equal(game.status, 'error');
  assert.deepEqual(applied, []);
  assert.equal(game.busy, false);
  assert.equal(game.count, 0);
  assert.equal(game.pendingApplied, null);
  const failure = JSON.parse(
    readFileSync(game.logPath, 'utf8').trim().split('\n').at(-1),
  );
  assert.equal(failure.phase, 'pre-action');
  game.restart();
  game.log = () => {
    throw new Error('disk full');
  };
  await assert.rejects(game.step(), /disk full/);
  assert.deepEqual(applied, []);
});

test('post-action sampling and logging failures preserve the applied Choice and stop without replay', async (t) => {
  for (const failingPhase of [
    'sample',
    'invalid-ram',
    'applied',
    'transition',
  ]) {
    const { game, applied } = gameFor(t);
    game.load(Buffer.from('test-only'));
    const append = game.log.bind(game);
    game.log = (event) => {
      if (event.kind === failingPhase)
        throw new Error(`failed ${failingPhase}`);
      append(event);
    };
    if (failingPhase === 'sample') {
      game.telemetry.sample = () => {
        throw new Error('failed sample');
      };
    }
    if (failingPhase === 'invalid-ram') {
      const advance = game.emulator.advance;
      game.emulator.advance = function (action, frames) {
        const result = advance.call(this, action, frames);
        this.ram[0x7f8] = 10;
        return result;
      };
    }
    await assert.rejects(game.step(), /action already applied at frame 8/);
    assert.deepEqual(applied, ['right_run']);
    assert.equal(game.count, 1);
    assert.equal(game.lastDecision.action, 'right_run');
    assert.equal(game.info().pendingApplied.index, 0);
    assert.equal(game.pendingApplied.frame, 8);
    assert.equal(game.pendingApplied.beforeFrame, 0);
    assert.equal(game.pendingApplied.frames, 8);
    assert.equal(game.pendingApplied.action, 'right_run');
    assert.deepEqual(game.pendingApplied.ram, Array.from(game.emulator.ram));
    assert.equal(game.status, 'error');
    assert.equal(game.busy, false);
    await assert.rejects(game.step(), /run failed/);
    assert.deepEqual(applied, ['right_run']);
    const events = readFileSync(game.logPath, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events.at(-1).phase, 'post-action');
    assert.equal(
      events.some((event) => event.kind === 'applied'),
      failingPhase !== 'applied',
    );
    assert.equal(
      events.some((event) => event.kind === 'transition'),
      false,
    );
  }
});

test('post-action automatic sampling failure persists neutral frames without inventing a Choice', async (t) => {
  const { game, applied } = gameFor(t);
  game.load(Buffer.from('test-only'));
  game.emulator.ram[0xe] = 3;
  game.emulator.frame = 1;
  game.snapshot = game.telemetry.sample(game.emulator.ram, 1);
  game.emulator.advanceTransition = function (frames) {
    this.frame += frames;
    return frames;
  };
  game.telemetry.sample = () => {
    throw new Error('failed automatic sample');
  };
  await assert.rejects(game.step(), /action already applied at frame 61/);
  assert.deepEqual(applied, []);
  assert.equal(game.count, 0);
  assert.equal(game.transitionFrames, 60);
  assert.equal(game.pendingApplied.kind, 'automatic-applied');
  assert.equal(game.pendingApplied.frames, 60);
  const events = readFileSync(game.logPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['start', 'automatic-applied', 'error'],
  );
  assert.equal(events.at(-1).phase, 'post-action');
});

test('continuous loop stops at death and never automatically restarts', async (t) => {
  const { game } = gameFor(t, { experienceEnabled: true });
  game.load(Buffer.from('test-only'));
  const advance = game.emulator.advance;
  game.emulator.advance = function (action, frames) {
    const result = advance.call(this, action, frames);
    this.ram[0xe] = 11;
    return result;
  };
  game.start();
  await game.loop;
  assert.equal(game.status, 'dead');
  assert.equal(game.running, false);
  assert.equal(game.count, 1);
  assert.throws(() => game.start(), /ended/);
  assert.equal(game.info().learning.deaths, 1);
  game.restart();
  assert.equal(game.info().learning.deaths, 1);
  assert.equal(
    game.info().learning.episodes,
    1,
    'restart does not duplicate a completed episode',
  );
  assert.equal(
    game.snapshot.experience.nearbyEpisodes[0].trace[0].action,
    'right_run',
  );
});

test('continuous mode advances death animations then resumes the model with fewer lives', async (t) => {
  const { game, applied } = gameFor(t, { continuousPlay: true });
  game.load(Buffer.from('test-only'));
  game.telemetry.completedLevels.add('1-1');
  const advance = game.emulator.advance;
  game.emulator.advance = function (action, frames) {
    const result = advance.call(this, action, frames);
    if (game.count === 0) this.ram[0xe] = 11;
    return result;
  };
  game.emulator.advanceTransition = function () {
    this.frame += 60;
    this.ram[0xe] = 8;
    this.ram[0x75a]--;
    return 60;
  };
  await game.step();
  assert.equal(game.status, 'respawning');
  const runId = game.runId;
  await game.step();
  assert.equal(game.count, 1);
  assert.equal(game.snapshot.player.lives, 2);
  assert.equal(game.snapshot.player.dead, false);
  assert.equal(game.runId, runId);
  assert.deepEqual(game.snapshot.campaign.completedLevels, ['1-1']);
  await game.step();
  assert.deepEqual(applied, ['right_run', 'right_run']);
  assert.equal(game.count, 2);
});

test('continuous mode restarts only after game over and clears campaign progress', async (t) => {
  let calls = 0;
  const { game } = gameFor(t, {
    continuousPlay: true,
    decide: async () => {
      if (++calls === 2) game.pause();
      return { ...parseDecision(answer()), latencyMs: 1 };
    },
  });
  game.load(Buffer.from('test-only'));
  const firstRun = game.runId;
  const firstLog = game.logPath;
  game.telemetry.completedLevels.add('1-1');
  game.emulator.advance = function (_action, frames) {
    this.frame += frames;
    this.ram[0x75a] = 255;
    return frames;
  };
  game.start();
  await game.loop;
  assert.notEqual(game.runId, firstRun);
  assert.deepEqual(game.snapshot.campaign.completedLevels, []);
  assert.equal(game.snapshot.player.lives, 3);
  assert.equal(game.running, false, 'manual pause is not auto-resumed');
  assert.equal(game.count, 0, 'new run does not reuse a prior decision');
  assert.match(readFileSync(firstLog, 'utf8'), /automatic-restart/);
});

test('continuous mode stops after all 32 stages instead of restarting a successful campaign', async (t) => {
  const { game } = gameFor(t, { continuousPlay: true });
  game.load(Buffer.from('test-only'));
  const runId = game.runId;
  for (let world = 1; world <= 8; world++)
    for (let stage = 1; stage <= 4; stage++)
      if (world !== 8 || stage !== 4)
        game.telemetry.completedLevels.add(`${world}-${stage}`);
  game.emulator.ram[0x75f] = 7;
  game.emulator.ram[0x75c] = 3;
  game.snapshot = game.telemetry.sample(game.emulator.ram, 1);
  game.emulator.advance = function (_action, frames) {
    this.frame += frames;
    this.ram[0x770] = 2;
    return frames;
  };
  game.start();
  await game.loop;
  assert.equal(game.status, 'clear');
  assert.equal(game.running, false);
  assert.equal(game.runId, runId);
  assert.equal(game.snapshot.campaign.completedLevels.length, 32);
});

test('new game defaults to sixteen frames and passes prior failures to the actual policy', async (t) => {
  let requestState;
  const { game } = gameFor(t, {
    experienceEnabled: true,
    framesPerDecision: undefined,
    continuousPlay: undefined,
    decide: async (state) => {
      requestState = structuredClone(state);
      return { ...parseDecision(answer('left')), latencyMs: 1 };
    },
  });

  game.load(Buffer.from('test-only'));
  game.experience.save({
    runId: 'prior',
    outcome: 'dead',
    state: game.snapshot,
    trace: [
      {
        x: 40,
        y: 208,
        action: 'right',
        toX: 48,
        toY: 208,
        headBump: false,
        landed: false,
        heldJump: false,
      },
    ],
  });
  await game.step();
  assert.equal(game.framesPerDecision, 16);
  assert.equal(game.maxDecisions, 20000);
  assert.equal(game.continuousPlay, true);
  assert.equal(game.emulator.frame, 16);
  assert.equal(requestState.experience.deaths, 1);
  assert.equal(
    game.lastDecision.action,
    'left',
    'memory must never override model Choice',
  );
});

test('memory read failures stop cleanly before inference and release the busy state', async (t) => {
  const { game, applied } = gameFor(t, { experienceEnabled: true });
  game.load(Buffer.from('test-only'));
  game.experience.recall = () => {
    throw new Error('corrupt experience');
  };
  await assert.rejects(game.step(), /corrupt experience/);
  assert.equal(game.busy, false);
  assert.equal(game.status, 'error');
  assert.deepEqual(applied, []);
});

test('manual restart remembers partial progress but never calls it a victory', async (t) => {
  const { game } = gameFor(t, { experienceEnabled: true });
  game.load(Buffer.from('test-only'));
  await game.step();
  game.restart();
  const records = game.experience.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'restarted');
  assert.equal(records[0].bestX, 48);
});

test('experience is disabled by default across steps, restarts and existing history', async (t) => {
  const { game: prior } = gameFor(t, { experienceEnabled: true });
  prior.load(Buffer.from('test-only'));
  await prior.step();
  prior.restart();
  const history = prior.experience.directory;
  const files = readdirSync(history);
  const path = join(history, files[0]);
  writeFileSync(path, 'deliberately invalid old record');
  let observed;
  const { game } = gameFor(t, {
    logDirectory: prior.logDirectory,
    decide: async (state) => {
      observed = state.experience;
      return { ...parseDecision(answer()), latencyMs: 1 };
    },
  });
  game.load(Buffer.from('test-only'));
  assert.equal(game.experience, null);
  await game.step();
  game.restart();
  assert.equal(observed, null);
  assert.equal(game.info().experienceEnabled, false);
  assert.equal(game.info().learning, null);
  assert.deepEqual(readdirSync(history), files);
  assert.equal(readFileSync(path, 'utf8'), 'deliberately invalid old record');
});

test('forecasts inform the model but never override its choice or add live frames', async (t) => {
  let input;
  const { game, applied } = gameFor(t, {
    decide: async (state) => {
      input = state.forecast;
      assert.equal(game.emulator.frame, 0);
      return { ...parseDecision(answer('left')), latencyMs: 1 };
    },
  });
  game.load(Buffer.from('test-only'));
  const forecast = {
    frames: 8,
    heldFor: 48,
    moves: { left: { next: [-8, 192, 'dead'] } },
  };
  game.emulator.forecast = () => forecast;
  await game.step();
  assert.deepEqual(input, forecast);
  assert.deepEqual(applied, ['left']);
  assert.equal(game.emulator.frame, 8);
});

test('live dashboard clears resolved game errors without hiding unrelated user errors', () => {
  const html = readFileSync(
    new URL('../public/index.html', import.meta.url),
    'utf8',
  );
  const nodes = Object.fromEntries(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => [
      match[1],
      {
        textContent: '',
        addEventListener() {},
        getContext() {
          return {};
        },
      },
    ]),
  );
  const page = {
    document: { getElementById: (id) => nodes[id] },
    fetch: () => new Promise(() => {}),
  };
  runInNewContext(
    `${readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8')}\nglobalThis.render = show;`,
    page,
  );
  const snapshot = {
    status: 'error',
    error: 'Official response rejected',
    decisions: 10,
    maxDecisions: 20000,
    framesPerDecision: 16,
    decisionBackend: 'jev-official',
    requestedModel: 'jev-1.14.0',
  };
  page.render(snapshot);
  assert.equal(nodes.error.textContent, snapshot.error);
  page.render({ ...snapshot, status: 'thinking', error: null });
  assert.equal(nodes.error.textContent, '');
  assert.equal(nodes['last-model'].textContent, '未提供');
  page.render({
    ...snapshot,
    status: 'thinking',
    error: null,
    state: { reaction_timing: { framesPerDecision: 8 } },
  });
  assert.match(nodes.count.textContent, /8 frames\/decision/);
  nodes.error.textContent = 'A separate control error';
  page.render({ ...snapshot, status: 'paused', error: null });
  assert.equal(nodes.error.textContent, 'A separate control error');
});

test('HTTP dashboard, legal local upload path, frame and CSRF protection', async (t) => {
  const { game } = gameFor(t, { makeEmulator: () => new MarioEmulator() });
  const server = createGameServer(game);
  await listen(server, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Jev Mario/);
  assert.match(
    page.headers.get('content-security-policy'),
    /default-src 'self'/,
  );
  const rawStatus = (path, headers) =>
    new Promise((resolve, reject) => {
      get(`${url}${path}`, { headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
  assert.equal(
    await rawStatus('/', {
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
    }),
    200,
    'external top-level links can open the app',
  );
  assert.equal(
    await rawStatus('/api/status', { 'Sec-Fetch-Site': 'cross-site' }),
    403,
    'cross-site subresources cannot read state',
  );
  assert.equal(
    (await (await fetch(`${url}/api/status`)).json()).status,
    'missing_rom',
  );
  const cross = await fetch(`${url}/api/control`, {
    method: 'POST',
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(cross.status, 403);
  const hostStatus = await rawStatus('/api/status', { Host: 'evil.example' });
  assert.equal(hostStatus, 403);
  const wrong = await fetch(`${url}/api/control`, {
    method: 'POST',
    body: '{"command":"start"}',
  });
  assert.equal(wrong.status, 400);
  const upload = await fetch(`${url}/api/rom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: homebrewROM(),
  });
  assert.equal(upload.status, 200);
  const step = await fetch(`${url}/api/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"command":"step"}',
  });
  assert.equal(step.status, 200);
  assert.equal((await step.json()).decisions, 1);
  const pixels = await (await fetch(`${url}/api/frame`)).arrayBuffer();
  assert.equal(pixels.byteLength, 245760);
});
