import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { NES } from 'jsnes';
import {
  ACTIONS,
  BrowserMario,
  bindKeyboard,
  sha256,
  validateROM,
} from '../browser/core.mjs';
import { MarioEmulator } from '../emulator.mjs';
import { ACTIONS as nativeActions } from '../policy.mjs';
import {
  publicDecision,
  publicInput,
  publicText,
} from '../scripts/public-history.mjs';
import { readPlayer } from '../telemetry.mjs';
import { homebrewROM } from './fixtures.mjs';

test('browser ROM boot and partial replay exactly match native emulator', async () => {
  assert.deepEqual(ACTIONS, nativeActions);
  const rom = homebrewROM();
  const native = new MarioEmulator();
  const browser = new BrowserMario(NES);
  native.boot(rom);
  browser.boot(new Uint8Array(rom));
  assert.deepEqual(browser.player, readPlayer(native.ram));
  assert.equal(await sha256(browser.pixels), await sha256(native.pixels));
  native.advance('right_run', 16);
  const event = {
    index: 0,
    automatic: false,
    action: 'right_run',
    frames: 16,
    frame: 16,
    player: readPlayer(native.ram),
    completedLevels: [],
    history: { inputFrame: 0, answers: { move: { choice: 'right_run' } } },
  };
  assert.equal(browser.advance(event, 4), false);
  assert.equal(browser.count, 0);
  assert.equal(browser.advance(event, 60), true);
  assert.equal(browser.count, 1);
  assert.equal(await sha256(browser.pixels), await sha256(native.pixels));
  assert.throws(() => browser.advance(event), /boundary/);
  assert.throws(() => validateROM(new Uint8Array(5)), /iNES/);
  const invalid = new Uint8Array(rom);
  invalid[6] = 0x40;
  assert.throws(() => validateROM(invalid), /iNES/);
  await assert.rejects(
    browser.verifyTerminal({
      totalFrames: 16,
      totalDecisions: 1,
      pixelSHA256: await sha256(browser.pixels),
    }),
    /Terminal/,
  );
});

test('browser rejects mismatched Choice and physical replay boundary', () => {
  const game = new BrowserMario(NES);
  game.boot(new Uint8Array(homebrewROM()));
  const event = {
    index: 0,
    automatic: false,
    action: 'right',
    frames: 1,
    frame: 1,
    player: { x: -100 },
    completedLevels: [],
    history: { inputFrame: 0, answers: { move: { choice: 'left' } } },
  };
  assert.throws(() => game.advance(event), /Choice/);
  event.history.answers.move.choice = 'right';
  assert.throws(() => game.advance(event), /player.x/);
});

test('public history only admits gameplay keys and safe text', () => {
  assert.deepEqual(publicInput({ game: { memory: [], player: { x: 40 } } }), {
    game: { memory: [], player: { x: 40 } },
  });
  for (const value of [
    { authorization: 'test' },
    { account: 'someone' },
    { game: { memory: [{ x: 1 }] } },
    { x: Number.NaN },
    { game: { goal: '/Users/example/private' } },
    { game: { goal: 'Bearer test-only-value' } },
    { game: { goal: 'https://example.invalid' } },
    { game: { goal: 'person@example.invalid' } },
  ])
    assert.throws(() => publicInput(value));
  assert.throws(() => publicText('a'.repeat(2049)));
  const decision = {
    action: 'right',
    latencyMs: 10,
    modelInput: { game: { memory: [] } },
    modelQuestions: {
      move: {
        type: 'choice',
        instructions: 'Move safely.',
        criteria: { right: 'right' },
      },
      jump_needed: { type: 'noul', instructions: 'Jump?' },
    },
    raw: {
      account: 'not-published',
      headers: { arbitrary: 'not-published' },
      answers: {
        move: {
          type: 'choice',
          choice: 'right',
          confidence: 0.5,
          probabilities: { right: 0.5 },
        },
        jump_needed: { type: 'noul', noul: 0.2 },
      },
    },
  };
  const result = publicDecision(decision, { state: { episode: { frame: 0 } } });
  assert.equal(JSON.stringify(result).includes('not-published'), false);
  assert.equal(result.answers.move.confidence, 0.5);
  decision.raw.answers.move.choice = 'left';
  assert.throws(() =>
    publicDecision(decision, { state: { episode: { frame: 0 } } }),
  );
});

test('manual keyboard releases on blur, visibility, page exit and ignores other fields', () => {
  const target = new EventTarget();
  target.document = new EventTarget();
  const canvas = new EventTarget();
  let releases = 0;
  let pauses = 0;
  const keyboard = bindKeyboard(
    target,
    canvas,
    {
      release() {
        releases++;
      },
    },
    () => pauses++,
  );
  function key(type, code) {
    const event = new Event(type, { cancelable: true });
    event.code = code;
    target.dispatchEvent(event);
  }
  key('keydown', 'ArrowRight');
  assert.equal(keyboard.buttons().size, 0);
  target.document.activeElement = canvas;
  key('keydown', 'ArrowRight');
  key('keydown', 'KeyZ');
  assert.deepEqual([...keyboard.buttons()], [7, 0]);
  key('keyup', 'KeyZ');
  assert.deepEqual([...keyboard.buttons()], [7]);
  for (const [source, type] of [
    [target, 'blur'],
    [canvas, 'blur'],
    [target, 'pagehide'],
    [target.document, 'visibilitychange'],
  ]) {
    key('keydown', 'ArrowRight');
    target.document.hidden = true;
    source.dispatchEvent(new Event(type));
    assert.equal(keyboard.buttons().size, 0);
  }
  assert.equal(releases, 4);
  assert.equal(pauses, 4);
});

test('static deployment is isolated from Node API, credentials and private resources', async () => {
  const app = await readFile(
    new URL('../browser/app.mjs', import.meta.url),
    'utf8',
  );
  const html = await readFile(
    new URL('../browser/index.html', import.meta.url),
    'utf8',
  );
  const build = await readFile(
    new URL('../scripts/build-static.mjs', import.meta.url),
    'utf8',
  );
  const packageJSON = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const pagesConfig = JSON.parse(
    await readFile(
      new URL('../cloudflare-pages/wrangler.jsonc', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(pagesConfig, {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: 'jev-mario',
    compatibility_date: '2026-10-01',
    pages_build_output_dir: '../.cloudflare/site',
  });
  for (const command of ['deploy:static', 'deploy:pages', 'preview:static']) {
    assert(
      packageJSON.scripts[command].includes(
        'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false',
      ),
    );
    assert(
      packageJSON.scripts[command].includes(
        'CLOUDFLARE_INCLUDE_PROCESS_ENV=false',
      ),
    );
    assert(
      packageJSON.scripts[command].includes('WRANGLER_SEND_METRICS=false'),
    );
  }
  for (const command of ['deploy:static', 'deploy:pages']) {
    assert(
      packageJSON.scripts[command].includes(
        'wrangler pages deploy --cwd cloudflare-pages --project-name jev-mario --branch this-that-local',
      ),
    );
  }
  assert(!app.includes('/api/'));
  assert(
    !/XMLHttpRequest|WebSocket|sendBeacon|FormData|method:\s*['"]POST/.test(
      app,
    ),
  );
  assert(app.includes('file.arrayBuffer()'));
  assert(html.includes('加载本地 ROM / Load ROM'));
  assert(html.includes('<button id="manual" disabled>开始游戏 / Start game'));
  assert(app.includes('ROM loaded locally; click Start game or Replay.'));
  assert(html.includes("connect-src 'self'"));
  assert(html.includes("form-action 'none'"));
  assert(build.includes('Unexpected public build file.'));
  assert(!build.includes("'public/"));
  assert(!build.includes("'server.mjs'"));
});
