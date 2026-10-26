import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { NES } from 'jsnes';
import { loadHostedROM } from '../browser/assets.mjs';
import {
  ACTIONS,
  BrowserMario,
  bindKeyboard,
  sha256,
  validateROM,
} from '../browser/core.mjs';
import { messages, translate } from '../browser/i18n.mjs';
import { MarioEmulator } from '../emulator.mjs';
import { ACTIONS as nativeActions } from '../policy.mjs';
import {
  publicDecision,
  publicInput,
  publicText,
} from '../scripts/public-history.mjs';
import { readPlayer } from '../telemetry.mjs';
import { homebrewROM } from './fixtures.mjs';

test('hosted ROM fetch is bounded, credential-free and hash checked', async (t) => {
  const rom = new Uint8Array(homebrewROM());
  const hash = await sha256(rom);
  let response = () => new Response(rom);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, './rom/game.nes');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    return response();
  });
  await assert.rejects(loadHostedROM(null), /valid audit hash/);
  assert.equal(calls, 0);
  assert.deepEqual(await loadHostedROM(hash), { bytes: rom, hash });
  await assert.rejects(loadHostedROM('0'.repeat(64)), /SHA-256 differs/);
  response = () => new Response('not found', { status: 404 });
  await assert.rejects(loadHostedROM(hash), /HTTP 404/);
  response = () => new Response(new Uint8Array(40977));
  await assert.rejects(loadHostedROM(hash), /size limit/);
  response = () => new Response(new Uint8Array(40976));
  await assert.rejects(loadHostedROM(hash), /iNES/);
  response = () => {
    throw new Error('Network unavailable');
  };
  await assert.rejects(loadHostedROM(hash), /Network unavailable/);
});

test('language and half-speed controls preserve loaded ROM and replay progress', async (t) => {
  class Element extends EventTarget {
    handlers = new Map();
    textContent = '';
    disabled = true;
    attributes = {};
    addEventListener(name, handler) {
      this.handlers.set(name, handler);
    }
    getContext() {
      return { putImageData() {} };
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }
  const elements = new Map();
  const document = new EventTarget();
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.documentElement = { lang: 'zh-CN' };
  const html = await readFile(
    new URL('../browser/index.html', import.meta.url),
    'utf8',
  );
  const translatedElements = [
    ...html.matchAll(/<[^>]+data-i18n="([^"]+)"[^>]*>/g),
  ].map(([tag, key]) => {
    const id = tag.match(/id="([^"]+)"/)?.[1];
    const element = id ? document.getElementById(id) : new Element();
    element.dataset = { i18n: key };
    return element;
  });
  document.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-i18n]');
    return translatedElements;
  };
  const window = new EventTarget();
  window.document = document;
  const replacements = {
    window,
    document,
    jsnes: { NES },
    ImageData: class {},
  };
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, replacements);
  t.after(() => {
    for (const key of Object.keys(replacements)) {
      if (originals[key])
        Object.defineProperty(globalThis, key, originals[key]);
      else delete globalThis[key];
    }
  });
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(performance, 'now', () => 0);
  const rom = new Uint8Array(homebrewROM());
  const native = new MarioEmulator();
  native.boot(Buffer.from(rom));
  const events = [0, 1].map((index) => {
    native.advance('right_run', 16);
    return {
      index,
      automatic: false,
      action: 'right_run',
      frames: 16,
      frame: (index + 1) * 16,
      player: readPlayer(native.ram),
      completedLevels: [],
      history: {
        inputFrame: index * 16,
        input: { game: { player: { x: 40 } } },
        questions: { move: { instructions: 'Move safely.' } },
        answers: { move: { choice: 'right_run' } },
        latencyMs: 10,
      },
    };
  });
  const chunk = JSON.stringify(events);
  const manifest = {
    version: 1,
    totalDecisions: 6275,
    totalFrames: 113645,
    chunks: [
      {
        file: 'events-000.json',
        events: 2,
        sha256: await sha256(new TextEncoder().encode(chunk)),
      },
    ],
    romSHA256: await sha256(rom),
  };
  let failed = false;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    if (url === './history/manifest.json') return Response.json(manifest);
    if (url === './history/events-000.json') return new Response(chunk);
    assert.equal(url, './rom/game.nes');
    return failed
      ? new Response('unavailable', { status: 503 })
      : new Response(rom);
  });
  await import('../browser/app.mjs');
  const get = (id) => document.getElementById(id);
  assert.deepEqual(requests, ['./history/manifest.json']);
  assert.equal(get('manual').disabled, true);
  assert.equal(get('load-rom').disabled, false);
  assert.equal(get('manual').textContent, '开始游戏');
  await get('load-rom').handlers.get('click')();
  assert.equal(get('manual').disabled, false);
  assert.equal(get('replay').disabled, false);
  assert.equal(get('toggle').disabled, true);
  assert.equal(get('state').textContent, '未加载');
  assert(get('message').textContent.includes('ROM 已从 Cloudflare 加载'));
  const click = (id) => get(id).handlers.get('click')();
  click('language');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.title, 'Jev Mario · Replay & Play');
  assert.equal(get('manual').textContent, 'Start game');
  assert(get('message').textContent.includes('loaded from Cloudflare'));
  assert(get('screen').attributes['aria-label'].startsWith('Mario game.'));
  assert.equal(get('language').attributes['aria-label'], '切换为中文');
  for (const speed of [4, 16, 0.5, 1, 4, 16, 0.5]) {
    click('speed');
    assert.equal(get('speed').textContent, `Replay speed ${speed}×`);
  }
  await get('manual').handlers.get('click')();
  assert.equal(JSON.parse(get('state').textContent).mode, 'manual');
  assert.equal(JSON.parse(get('state').textContent).frame, 0);
  await timers.at(-1).callback();
  assert.equal(JSON.parse(get('state').textContent).frame, 1);
  assert.equal(timers.at(-1).delay, 1000 / 60);
  await click('replay');
  await timers.at(-1).callback();
  assert.equal(JSON.parse(get('state').textContent).frame, 2);
  assert.equal(timers.at(-1).delay, (2 * 1000) / (60 * 0.5));
  click('toggle');
  const before = ['state', 'input', 'questions', 'answers'].map(
    (id) => get(id).textContent,
  );
  const requestCount = requests.length;
  click('language');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(get('speed').textContent, '回放速度 0.5×');
  assert.equal(get('toggle').textContent, '继续');
  assert(get('decision').textContent.startsWith('输入帧 0'));
  assert.deepEqual(
    ['state', 'input', 'questions', 'answers'].map((id) => get(id).textContent),
    before,
  );
  assert.equal(requests.length, requestCount);
  assert.equal(get('manual').disabled, false);
  await click('step');
  assert.equal(JSON.parse(get('state').textContent).frame, 16);
  assert.equal(JSON.parse(get('state').textContent).decisions, 1);
  click('language');
  failed = true;
  await get('load-rom').handlers.get('click')();
  assert.equal(get('manual').disabled, true);
  assert.equal(get('replay').disabled, true);
  assert(get('message').textContent.includes('HTTP 503'));
  assert.equal(get('state').textContent, 'Not loaded');
  assert(get('message').textContent.startsWith('Stopped:'));
  click('language');
  assert(get('message').textContent.startsWith('停止：'));
  assert(get('message').textContent.includes('HTTP 503'));
});

test('both UI languages cover every label and preserve interpolation values', async () => {
  assert.deepEqual(
    Object.keys(messages.en).sort(),
    Object.keys(messages['zh-CN']).sort(),
  );
  const html = await readFile(
    new URL('../browser/index.html', import.meta.url),
    'utf8',
  );
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert(translate('zh-CN', key));
    assert(translate('en', key));
  }
  assert.equal(translate('en', 'speed', { speed: 0.5 }), 'Replay speed 0.5×');
  assert.equal(translate('zh-CN', 'speed', { speed: 0.5 }), '回放速度 0.5×');
  assert.throws(() => translate('fr', 'start'), /Missing UI translation/);
  assert.throws(() => translate('en', 'speed'), /Missing UI translation value/);
});

test('static builds require explicit ROM distribution authorization', () => {
  const result = spawnSync(process.execPath, ['scripts/build-static.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      MARIO_ROM_DISTRIBUTION_AUTHORIZED: 'false',
      MARIO_PUBLIC_ROM: '',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Public hosting requires distribution rights/);
});

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
  assert(html.includes('<button id="load-rom" data-i18n="loadROM" disabled>'));
  assert(html.includes('<button id="manual" data-i18n="start" disabled>'));
  assert(html.includes('<button id="language"'));
  assert(app.includes("hosted ? 'loadedHosted' : 'loadedLocal'"));
  assert(app.includes('loadHostedROM(manifest?.romSHA256)'));
  assert(html.includes("connect-src 'self'"));
  assert(html.includes("form-action 'none'"));
  assert(build.includes('Unexpected public build file.'));
  assert(!build.includes("'public/"));
  assert(!build.includes("'server.mjs'"));
});
