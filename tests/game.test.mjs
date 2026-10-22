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
import { MarioEmulator, validateROM } from '../emulator.mjs';
import { Game } from '../game.mjs';
import { listen } from '../http.mjs';
import { parseDecision } from '../policy.mjs';
import { createGameServer } from '../server.mjs';
import { answer, homebrewROM, ramFixture } from './fixtures.mjs';

function gameFor(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-jev-mario-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const applied = [];
  const game = new Game({
    logDirectory: directory,
    framesPerDecision: 8,
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
  emulator.ram[0xe] = 11;
  assert.equal(emulator.advance('right', 8), 0);
  assert.throws(() => emulator.advance('not-an-action', 8), /Unknown action/);
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
  assert.equal(Object.keys(forecast.moves).length, 7);
  assert.equal(emulator.frame, 0);
  assert.equal(JSON.stringify(emulator.nes.toJSON()), before);
  assert.deepEqual(emulator.pixels, pixels);
  emulator.advance('right_run_jump', 16);
  assert.equal(forecast.moves.right_run_jump.next[0], emulator.ram[0x86] - x);
  emulator.advance('right_run_jump', 44);
  assert.equal(forecast.moves.right_run_jump.held[0], emulator.ram[0x86] - x);
});

test('forecasts detect whether any follow-up survives another decision interval', () => {
  const trapped = new MarioEmulator();
  trapped.boot(homebrewROM({ deathX: 60 }));
  trapped.ram[0x700] = 1;
  trapped.ram[0x86] = 40;
  const trappedMove = trapped.forecast(16).moves.right_run;
  assert.notEqual(trappedMove.next[2], 'dead');
  assert.equal(trappedMove.held[2], 'dead');
  assert.equal(trappedMove.noSurvivingFollowup, true);

  const viable = new MarioEmulator();
  viable.boot(homebrewROM({ deathX: 80 }));
  viable.ram[0x700] = 1;
  viable.ram[0x86] = 40;
  const viableMove = viable.forecast(16).moves.right_run;
  assert.notEqual(viableMove.next[2], 'dead');
  assert.equal(viableMove.held[2], 'dead');
  assert.equal(viableMove.noSurvivingFollowup, undefined);
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
    ['start', 'request', 'choice', 'transition'],
  );
  assert.equal(events[3].frames, 8);
  assert.equal(events[3].state.episode.frame, 8);
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
  game.restart();
  game.log = () => {
    throw new Error('disk full');
  };
  await assert.rejects(game.step(), /disk full/);
  assert.deepEqual(applied, []);
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

test('new game defaults to sixteen frames and passes prior failures to the actual policy', async (t) => {
  let requestState;
  const { game } = gameFor(t, {
    experienceEnabled: true,
    framesPerDecision: undefined,
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
  assert.match(await page.text(), /Local Jev Mario/);
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
