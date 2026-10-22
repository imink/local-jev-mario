import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Experience } from '../experience.mjs';

const hash = 'a'.repeat(64);
const state = {
  player: { x: 312, world: 1, stage: 1 },
  episode: { bestX: 312 },
};
const trace = [
  {
    x: 240,
    y: 192,
    action: 'right_run_jump',
    toX: 264,
    toY: 155,
    headBump: true,
    landed: false,
    heldJump: true,
  },
  {
    x: 288,
    y: 188,
    action: 'right_run_jump',
    toX: 312,
    toY: 192,
    headBump: false,
    landed: true,
    heldJump: true,
  },
];
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'mario-experience-test-'));
  t.after(() => rmSync(path, { recursive: true }));
  return path;
}

test('death evidence survives a new process instance and preserves factual sequence', (t) => {
  const path = directory(t);
  new Experience(path, hash, 16).save({
    runId: 'first',
    outcome: 'dead',
    state,
    trace,
  });
  const memory = new Experience(path, hash, 16).recall({
    ...state,
    player: { ...state.player, x: 180 },
  });
  assert.equal(memory.episodes, 1);
  assert.equal(memory.deaths, 1);
  assert.deepEqual(memory.nearbyEpisodes[0].trace, trace);
  assert.equal(memory.nearbyEpisodes[0].outcome, 'dead');
});

test('ROM, cadence, world and position isolate relevant experience', (t) => {
  const path = directory(t);
  const memory = new Experience(path, hash, 8);
  memory.save({ runId: 'first', outcome: 'dead', state, trace });
  assert.equal(new Experience(path, hash, 16).recall(state).episodes, 0);
  assert.equal(
    new Experience(path, 'b'.repeat(64), 8).recall(state).episodes,
    0,
  );
  assert.equal(
    memory.recall({ ...state, player: { ...state.player, world: 2 } })
      .nearbyEpisodes.length,
    0,
  );
  assert.equal(
    memory.recall({ ...state, player: { ...state.player, x: 900 } })
      .nearbyEpisodes.length,
    0,
  );
});

test('memory bounds recall and keeps limit/restarted progress distinct from success', (t) => {
  const memory = new Experience(directory(t), hash, 16);
  for (let i = 0; i < 4; i++)
    memory.save({ runId: `death-${i}`, outcome: 'dead', state, trace });
  memory.save({ runId: 'partial', outcome: 'limit', state, trace });
  const recalled = memory.recall({
    ...state,
    player: { ...state.player, x: 200 },
  });
  assert.equal(recalled.nearbyEpisodes.length, 3);
  assert.equal(
    recalled.nearbyEpisodes.filter((episode) => episode.outcome === 'dead')
      .length,
    2,
  );
  assert.equal(recalled.nearbyEpisodes[2].outcome, 'limit');
  assert.equal(recalled.deaths, 4);
});

test('corrupt memory raises an explicit error instead of pretending there is no history', (t) => {
  const memory = new Experience(directory(t), hash, 16);
  memory.save({ runId: 'first', outcome: 'dead', state, trace });
  const file = readdirSync(memory.directory)[0];
  writeFileSync(join(memory.directory, file), '{}');
  assert.throws(() => memory.recall(state), /Invalid cross-episode memory/);
});

test('a stalled restarted episode remains a relevant failure at the same obstacle', (t) => {
  const memory = new Experience(directory(t), hash, 16);
  const stalled = {
    ...trace[0],
    x: 434,
    toX: 434,
    action: 'right_run',
    headBump: false,
    heldJump: false,
  };
  const state = {
    player: { x: 434, world: 1, stage: 1 },
    episode: { bestX: 434 },
  };
  memory.save({
    runId: 'stuck',
    outcome: 'restarted',
    state,
    trace: [stalled, stalled, stalled],
  });
  const episode = memory.recall(state).nearbyEpisodes[0];
  assert.equal(episode.outcome, 'restarted');
  assert.equal(episode.failureReason, 'no_forward_progress');
});
