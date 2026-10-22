import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Telemetry, readPlayer, tileAt } from '../telemetry.mjs';
import { ramFixture } from './fixtures.mjs';

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
  }
  ram[0x0e] = 8;
  ram[0xb5] = 2;
  assert.equal(readPlayer(ram).dead, true);
  ram[0xb5] = 1;
  ram[0x1d] = 3;
  assert.equal(readPlayer(ram).clear, false, 'vine is not a flag');
  ram[0x16] = 0x31;
  assert.equal(readPlayer(ram).clear, true);
  ram[0x1d] = 0;
  ram[0x770] = 2;
  assert.equal(readPlayer(ram).clear, true);
});

test('missing RAM and malformed HUD are explicit errors', () => {
  assert.throws(() => readPlayer(null), /2 KiB/);
  const ram = ramFixture();
  ram[0x7f8] = 255;
  assert.throws(() => readPlayer(ram), /HUD/);
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
});
