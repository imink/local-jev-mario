import { boundedBytes, loadHostedROM } from './assets.mjs';
import { BrowserMario, bindKeyboard, sha256, validateROM } from './core.mjs';
import { translate } from './i18n.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const context = canvas.getContext('2d');
const game = new BrowserMario(globalThis.jsnes.NES);
let manifest;
let rom;
let romHash;
let mode = 'idle';
let playing = false;
let busy = false;
let generation = 0;
let timer;
let chunkIndex = 0;
let eventIndex = 0;
let chunk;
let phase = 'before';
let verifiedHash = null;
let replaySpeed = 1;
const replaySpeeds = [0.5, 1, 4, 16];
let language = 'zh-CN';
let message = { key: 'initial', values: {} };
const t = (key, values) => translate(language, key, values);

function showMessage(key, values = {}) {
  message = { key, values };
  $('message').textContent = t(key, values);
}

function updateLanguage() {
  document.documentElement.lang = language;
  document.title = t('title');
  for (const element of document.querySelectorAll('[data-i18n]'))
    element.textContent = t(element.dataset.i18n);
  canvas.setAttribute('aria-label', t('canvas'));
  $('language').textContent = language === 'zh-CN' ? 'English' : '中文';
  $('language').lang = language === 'zh-CN' ? 'en' : 'zh-CN';
  $('language').setAttribute(
    'aria-label',
    language === 'zh-CN' ? 'Switch to English' : '切换为中文',
  );
  showMessage(message.key, message.values);
  render();
}

function controls() {
  $('rom').disabled = busy;
  $('load-rom').disabled = busy || !manifest;
  $('replay').disabled = busy || !rom || !manifest;
  $('manual').disabled = busy || !rom;
  $('toggle').disabled = busy || mode === 'idle' || phase === 'complete';
  $('step').disabled =
    busy || playing || mode !== 'replay' || phase === 'complete';
  $('toggle').textContent = t(playing ? 'pause' : 'resume');
  $('speed').textContent = t('speed', { speed: replaySpeed });
}

function pause() {
  playing = false;
  clearTimeout(timer);
  game.release();
  controls();
}

const keyboard = bindKeyboard(window, canvas, game, () => {
  if (mode === 'manual') pause();
});

function render() {
  context.putImageData(new ImageData(game.pixels, 256, 240), 0, 0);
  if (mode !== 'idle') {
    const p = game.player;
    $('state').textContent = JSON.stringify(
      {
        mode,
        phase,
        frame: game.frame,
        decisions: mode === 'replay' ? game.count : null,
        totalDecisions: manifest?.totalDecisions,
        completedLevels: game.completedLevels,
        level: `${p.world}-${p.stage}`,
        x: p.x,
        y: p.y,
        lives: p.lives,
        time: p.time,
        clear: p.clear,
        heldButtons: [...keyboard.buttons()],
        verifiedPixelSHA256: verifiedHash,
      },
      null,
      2,
    );
  } else $('state').textContent = t('notLoaded');
  const h = game.history;
  $('decision').textContent = h
    ? t('decision', {
        frame: h.inputFrame,
        choice: h.answers.move.choice,
        latency: h.latencyMs,
      })
    : t('noDecision');
  $('input').textContent = h ? JSON.stringify(h.input, null, 2) : '—';
  $('questions').textContent = h ? JSON.stringify(h.questions, null, 2) : '—';
  $('answers').textContent = h ? JSON.stringify(h.answers, null, 2) : '—';
  controls();
}

function fail(error) {
  pause();
  showMessage('stopped', { error: error.message });
}

async function boundedJSON(url, limit, expectedHash) {
  const bytes = await boundedBytes(url, limit);
  if (expectedHash && (await sha256(bytes)) !== expectedHash)
    throw new Error('Static history chunk hash differs.');
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function currentEvent() {
  if (chunk && eventIndex < chunk.length) return chunk[eventIndex];
  if (chunk) {
    chunkIndex++;
    eventIndex = 0;
    chunk = null;
  }
  if (chunkIndex >= manifest.chunks.length) return null;
  const info = manifest.chunks[chunkIndex];
  if (!/^events-\d{3}\.json$/.test(info.file))
    throw new Error('Invalid static chunk path.');
  chunk = await boundedJSON(
    `./history/${info.file}`,
    2 * 1024 * 1024,
    info.sha256,
  );
  if (!Array.isArray(chunk) || chunk.length !== info.events)
    throw new Error('Static history chunk length differs.');
  return chunk[eventIndex];
}

async function advanceDecision(step) {
  let event = await currentEvent();
  if (!event) return;
  do {
    phase = event.automatic ? 'automatic' : 'action';
    const complete = game.advance(
      event,
      step ? 60 : Math.min(60, replaySpeed * 4),
    );
    if (complete) eventIndex++;
    if (!step || !complete) break;
    event = await currentEvent();
  } while (game.within || event?.automatic);
  const next = await currentEvent();
  if (!next) {
    verifiedHash = await game.verifyTerminal(manifest);
    phase = 'complete';
    pause();
    showMessage('complete');
  }
}

async function tick() {
  const token = generation;
  if (!playing || busy) return;
  const started = performance.now();
  const initialFrame = game.frame;
  busy = true;
  controls();
  try {
    if (mode === 'replay') await advanceDecision(false);
    else {
      game.manualFrame(keyboard.buttons());
    }
    render();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
    if (playing && token === generation) {
      const speed = mode === 'replay' ? replaySpeed : 1;
      const duration = ((game.frame - initialFrame) * 1000) / (60 * speed);
      timer = setTimeout(
        tick,
        Math.max(0, duration - (performance.now() - started)),
      );
    }
  }
}

async function start(nextMode) {
  if (busy) return;
  pause();
  keyboard.release();
  busy = true;
  generation++;
  controls();
  try {
    if (nextMode === 'replay' && romHash !== manifest.romSHA256)
      throw new Error(
        'Replay requires the exact Europe Rev A ROM SHA-256 shown below. Manual play supports other compatible revisions.',
      );
    game.boot(rom);
    mode = nextMode;
    phase = 'before';
    verifiedHash = null;
    chunkIndex = 0;
    eventIndex = 0;
    chunk = null;
    if (mode === 'replay') {
      const first = await currentEvent();
      game.history = first.history;
    }
    showMessage(mode === 'replay' ? 'replayStarted' : 'manualStarted');
    render();
    playing = true;
    timer = setTimeout(tick, mode === 'replay' ? 1200 : 0);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
  }
}

async function loadROM(hosted) {
  if (busy) return;
  pause();
  keyboard.release();
  mode = 'idle';
  rom = null;
  romHash = null;
  verifiedHash = null;
  game.history = null;
  game.pixels.fill(0);
  render();
  busy = true;
  controls();
  showMessage(hosted ? 'loadingHosted' : 'loadingLocal');
  try {
    if (hosted) {
      const loaded = await loadHostedROM(manifest?.romSHA256);
      romHash = loaded.hash;
      rom = loaded.bytes;
    } else {
      const file = $('rom').files[0];
      if (!file || file.size !== 40976)
        throw new Error('Choose a 40976-byte .nes file, not ZIP.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      validateROM(bytes);
      romHash = await sha256(bytes);
      rom = bytes;
    }
    showMessage(hosted ? 'loadedHosted' : 'loadedLocal', { hash: romHash });
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
  }
}
$('load-rom').addEventListener('click', () => loadROM(true));
$('rom').addEventListener('change', () => loadROM(false));
$('replay').addEventListener('click', () => start('replay'));
$('speed').addEventListener('click', () => {
  replaySpeed =
    replaySpeeds[(replaySpeeds.indexOf(replaySpeed) + 1) % replaySpeeds.length];
  controls();
});
$('language').addEventListener('click', () => {
  language = language === 'zh-CN' ? 'en' : 'zh-CN';
  updateLanguage();
});
$('manual').addEventListener('click', () => start('manual'));
$('toggle').addEventListener('click', () => {
  if (playing) pause();
  else {
    playing = true;
    if (mode === 'manual') canvas.focus();
    controls();
    tick();
  }
});
$('step').addEventListener('click', async () => {
  busy = true;
  controls();
  try {
    await advanceDecision(true);
    render();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
  }
});

updateLanguage();
try {
  manifest = await boundedJSON('./history/manifest.json', 65536);
  if (
    manifest.version !== 1 ||
    manifest.totalDecisions !== 6275 ||
    manifest.totalFrames !== 113645 ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length > 100
  )
    throw new Error('Unsupported static replay manifest.');
  $('provenance').textContent = JSON.stringify(manifest, null, 2);
  controls();
} catch (error) {
  fail(error);
}
