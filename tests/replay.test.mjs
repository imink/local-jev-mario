import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { MarioEmulator } from '../emulator.mjs';
import { listen } from '../http.mjs';
import { RecordedReplay } from '../replay.mjs';
import { createGameServer, restoreTerminalGame } from '../server.mjs';
import { Telemetry } from '../telemetry.mjs';
import { homebrewROM } from './fixtures.mjs';

function fixture(t, count = 3, rom = homebrewROM()) {
  const directory = mkdtempSync(join(tmpdir(), 'mario-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const logPath = join(directory, `${runId}.jsonl`);
  const emulator = new MarioEmulator();
  emulator.boot(rom);
  const telemetry = new Telemetry(8);
  const records = [
    {
      kind: 'start',
      runId,
      romSHA256: emulator.hash,
      framesPerDecision: 8,
      decisionBackend: 'jev-official',
    },
  ];
  let state = telemetry.sample(emulator.ram, 0);
  for (let index = 0; index < count; index++) {
    const request = { kind: 'request', index, state };
    if (index === 1) {
      records.push(request, {
        kind: 'error',
        message: 'Cancelled before execution.',
      });
    }
    const action = index % 2 ? 'left' : 'right';
    records.push(request, {
      kind: 'choice',
      index,
      decision: {
        action,
        raw: {
          engine: 'jev-official',
          model: 'fixture',
          answers: {
            move: {
              type: 'choice',
              choice: action,
              probabilities: { left: 0.9, right: 0.1 },
            },
          },
        },
        modelInput: { memory: [], p: state.player },
        modelQuestions: [{ name: 'move', type: 'choice' }],
      },
    });
    const frames = emulator.advance(action, 8);
    state = telemetry.sample(
      emulator.ram,
      emulator.frame,
      action,
      emulator.lastEvents,
    );
    records.push({
      kind: 'transition',
      index,
      action,
      frames,
      state,
      ...(index === 1
        ? {
            recovery: {
              method: 'fixture reconstruction',
              limitation: 'No original live snapshot.',
            },
          }
        : {}),
    });
    emulator.release();
    while (state.player.automatic) {
      const frames = emulator.advanceTransition(60);
      assert.ok(frames);
      state = telemetry.sample(
        emulator.ram,
        emulator.frame,
        'noop',
        emulator.lastEvents,
      );
      records.push({
        kind: 'automatic-transition',
        action: 'noop',
        frames,
        state,
      });
      emulator.release();
    }
  }
  writeFileSync(
    logPath,
    `${records.map((record) => JSON.stringify({ ...record, runId })).join('\n')}\n`,
  );
  return { directory, runId, logPath, rom, emulator, state, records };
}

async function openReplay(t, source) {
  const replay = await new RecordedReplay(source).open();
  t.after(() => replay.close());
  return replay;
}

test('indexed replay preserves raw Choice and historical input, partial frames, seek and terminal pixels', async (t) => {
  const source = fixture(t);
  const replay = await openReplay(t, source);
  const first = await replay.packet();
  assert.equal(first.frame, 0);
  assert.equal(first.history.inputFrame, 0);
  assert.equal(first.history.decision.action, 'right');
  assert.equal(first.history.decision.raw.answers.move.choice, 'right');
  assert.equal(first.history.decision.raw.answers.move.probabilities.left, 0.9);
  assert.equal(first.total, 3, 'failed request is not an executed action');
  assert.equal(first.reconstructions[0].index, 1);
  assert.deepEqual(
    Buffer.from(first.image, 'base64').subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await replay.advance(4);
  const partial = await replay.packet(0);
  assert.equal(
    partial.history,
    undefined,
    'unchanged large historical input is not retransmitted',
  );
  assert.equal(partial.frame, 4);
  assert.equal(partial.count, 0);
  await replay.step();
  assert.equal(replay.count, 1);
  assert.equal(replay.emulator.frame, 8);
  await replay.step();
  assert.equal((await replay.packet()).history.inputFrame, 8);
  await replay.seek(3);
  assert.equal(replay.phase, 'complete');
  assert.equal(replay.count, 3);
  assert.deepEqual(replay.emulator.pixels, source.emulator.pixels);
  assert.deepEqual(replay.emulator.nes.toJSON(), source.emulator.nes.toJSON());
  const finished = await replay.packet();
  await replay.advance();
  assert.equal((await replay.packet()).pixelSHA256, finished.pixelSHA256);
  await replay.seek(0);
  assert.equal(replay.emulator.frame, 0);
  assert.equal((await replay.packet()).history.index, 0);
  assert.equal(readFileSync(source.logPath).length, replay.stat.size);
});

test('native automatic frames remain visible, belong to the preceding Choice and restore a frozen terminal', async (t) => {
  const rom = homebrewROM();
  const boot = new MarioEmulator();
  boot.boot(rom);
  const startX = boot.ram[0x86];
  const nmi = rom.readUInt16LE(16 + 0x7ffa) - 0x8000 + 16;
  const instructions = [0xee, 0x86, 0];
  for (const [x, address, value] of [
    [startX + 3, 0x0e, 11],
    [startX + 7, 0x0e, 8],
    [startX + 11, 0x770, 3],
  ])
    instructions.push(
      0xa5,
      0x86,
      0xc9,
      x,
      0x90,
      5,
      0xa9,
      value,
      0x8d,
      address & 255,
      address >> 8,
    );
  instructions.push(0x40);
  rom.set(instructions, nmi);
  const source = fixture(t, 2, rom);
  assert.equal(source.state.player.gameOver, true);
  const replay = await openReplay(t, source);
  await replay.advance();
  assert.equal(replay.count, 1);
  assert.equal(replay.events[replay.cursor].automatic, true);
  const before = replay.emulator.frame;
  await replay.advance(1);
  const automatic = await replay.packet();
  assert.equal(automatic.phase, 'automatic');
  assert.equal(automatic.frame, before + 1);
  assert.equal(automatic.history.index, 0);
  await replay.step();
  assert.equal(
    replay.count,
    1,
    'finishes the current automatic transition, not a new Choice',
  );
  await replay.step();
  assert.equal(replay.count, 2);
  assert.equal(replay.phase, 'complete');
  assert.deepEqual(replay.emulator.nes.toJSON(), source.emulator.nes.toJSON());
  const original = readFileSync(source.logPath);
  const game = {
    logDirectory: source.directory,
    backend: 'jev-official',
    info() {
      return { status: this.status, decisions: this.count };
    },
  };
  assert.deepEqual(await restoreTerminalGame(game, source.runId, rom), {
    status: 'game_over',
    decisions: 2,
  });
  assert.deepEqual(game.emulator.pixels, source.emulator.pixels);
  assert.equal(game.snapshot.experience, null);
  assert.deepEqual(readFileSync(source.logPath), original);
});

test('seek checkpoints restore NES state and pixels without borrowing a later boundary', async (t) => {
  const source = fixture(t, 252);
  const replay = await openReplay(t, source);
  await replay.seek(250);
  const saved = serializeState(replay);
  await replay.seek(252);
  await replay.seek(250);
  assert.deepEqual(serializeState(replay), saved);
  assert.equal(replay.emulator.frame, 2000);
  await replay.seek(0);
  assert.equal(replay.emulator.frame, 0);
});

function serializeState(replay) {
  return {
    nes: replay.emulator.nes.toJSON(),
    pixels: Buffer.from(replay.emulator.pixels),
    count: replay.count,
  };
}

test('browser replay excludes stale live frames and never starts Agent or probes health', async (t) => {
  const source = fixture(t);
  const replay = await openReplay(t, source);
  const nodes = Object.fromEntries(
    [
      ...readFileSync(
        new URL('../public/index.html', import.meta.url),
        'utf8',
      ).matchAll(/id="([^"]+)"/g),
    ].map((match) => [
      match[1],
      {
        textContent: '',
        value: '1',
        addEventListener(type, listener) {
          this[type] = listener;
        },
        getContext() {
          return {
            drawImage() {
              drawings.push('replay');
            },
            putImageData() {
              drawings.push('live');
            },
          };
        },
      },
    ]),
  );
  const drawings = [];
  const calls = [];
  let finishLiveFrame;
  const liveFrame = new Promise((resolve) => {
    finishLiveFrame = resolve;
  });
  let finishSeek;
  const seekReady = new Promise((resolve) => {
    finishSeek = resolve;
  });
  const page = {
    document: { getElementById: (id) => nodes[id] },
    Uint8ClampedArray,
    Uint8Array,
    Blob,
    atob,
    createImageBitmap: async () => ({ close() {} }),
    ImageData: class {},
    setTimeout() {},
    clearTimeout() {},
    fetch: async (path, options) => {
      calls.push(path);
      if (path === '/api/status')
        return {
          ok: true,
          json: async () => ({ loaded: true, decisions: 3, status: 'paused' }),
        };
      if (path === '/api/frame')
        return { ok: true, arrayBuffer: () => liveFrame };
      assert.equal(path, '/api/replay');
      const input = JSON.parse(options.body);
      if (input.command === 'step') await replay.step();
      else if (input.command === 'seek') {
        await seekReady;
        await replay.seek(input.position);
      } else assert.equal(input.command, 'open');
      return {
        ok: true,
        json: async () => ({
          token: 'fixture',
          ...(await replay.packet(input.knownDecision)),
        }),
      };
    },
  };
  runInNewContext(
    readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8'),
    page,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await nodes['replay-open'].click();
  finishLiveFrame(new ArrayBuffer(245760));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(drawings, ['replay']);
  nodes['replay-toggle'].click();
  await nodes['replay-step'].click();
  assert.match(nodes['replay-progress'].textContent, /已执行 1\/3/);
  assert.match(nodes['replay-progress'].textContent, /输入帧 0 → 画面帧 8/);
  assert.equal(nodes.action.textContent, 'right');
  assert.equal(nodes.latency.textContent, '未提供');
  assert.equal(nodes.start.disabled, true);
  assert.equal(nodes.check.disabled, true);
  nodes['replay-position'].value = '0';
  const seeking = nodes['replay-seek'].click();
  assert.equal(
    nodes['replay-toggle'].disabled,
    true,
    'cannot resume a seek that has no playback timer',
  );
  finishSeek();
  await seeking;
  assert.equal(nodes['replay-toggle'].disabled, false);
  assert.match(nodes['replay-progress'].textContent, /已执行 0\/3/);
  assert.ok(
    calls.every((path) =>
      ['/api/status', '/api/frame', '/api/replay'].includes(path),
    ),
  );
  assert.equal(nodes.error.textContent, '');
});

test('replay refuses corrupt evidence, changed sources, invalid positions and wrong ROM', async (t) => {
  const source = fixture(t);
  const replay = await openReplay(t, source);
  await assert.rejects(replay.seek(-1), /position/);
  await assert.rejects(replay.seek(4), /position/);
  await assert.rejects(replay.advance(61), /frames/);
  await assert.rejects(replay.step(), /integrity failure/);
  await replay.seek(0);
  appendFileSync(source.logPath, '\n');
  await assert.rejects(replay.assertUnchanged(), /source log changed/);
  const other = fixture(t);
  const wrongROM = Buffer.from(other.rom);
  wrongROM[wrongROM.length - 1] ^= 1;
  await assert.rejects(
    new RecordedReplay({ ...other, rom: wrongROM }).open(),
    /ROM hash differs/,
  );
  const records = other.records.map((row) => ({ ...row, runId: other.runId }));
  records.find((row) => row.kind === 'transition').action = 'left';
  writeFileSync(
    other.logPath,
    `${records.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  await assert.rejects(
    new RecordedReplay(other).open(),
    /Expected values to be strictly equal/,
  );
});

test('replay HTTP API is bounded and isolated from all live controls, inference and logs', async (t) => {
  const source = fixture(t);
  const original = readFileSync(source.logPath);
  let liveCalls = 0;
  const game = {
    ...source,
    count: 3,
    backend: 'jev-official',
    logDirectory: source.directory,
    info: () => ({ loaded: true, decisions: 3, status: 'paused' }),
    start: () => liveCalls++,
    checkHealth: () => liveCalls++,
    load: () => liveCalls++,
  };
  const server = createGameServer(game);
  await listen(server, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, value, headers = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  assert.equal(
    (
      await post(
        '/api/replay',
        { command: 'open' },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/api/replay', { command: 'open', path: '../../.env' })).status,
    400,
  );
  const { value: opened } = await post('/api/replay', { command: 'open' });
  const token = opened.token;
  assert.equal(opened.frame, 0);
  assert.equal((await post('/api/control', { command: 'start' })).status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 400);
  assert.equal((await post('/api/rom', {})).status, 400);
  assert.equal(
    (await post('/api/replay', { command: 'tick', token: 'wrong', frames: 4 }))
      .status,
    400,
  );
  assert.equal(
    (await post('/api/replay', { command: 'seek', token, position: null }))
      .status,
    400,
  );
  const step = await post('/api/replay', { command: 'step', token });
  assert.equal(step.value.frame, 8);
  assert.equal(step.value.history.index, 0);
  assert.equal(
    (await post('/api/replay', { command: 'status', token })).value.frame,
    8,
    'paused status does not advance',
  );
  const final = await post('/api/replay', {
    command: 'seek',
    token,
    position: 3,
  });
  assert.equal(final.value.phase, 'complete');
  assert.equal(
    final.value.pixelSHA256,
    createHash('sha256').update(source.emulator.pixels).digest('hex'),
  );
  assert.equal(liveCalls, 0);
  assert.deepEqual(readFileSync(source.logPath), original);
  assert.equal(game.emulator.frame, 24);
  assert.equal(
    (await post('/api/replay', { command: 'close', token })).value.closed,
    true,
  );
  await assert.rejects(
    restoreTerminalGame(game, '../../.env', source.rom),
    /UUID/,
  );
  await assert.rejects(
    restoreTerminalGame(game, source.runId, source.rom),
    /Only a finished game/,
  );
  assert.deepEqual(readFileSync(source.logPath), original);
});
