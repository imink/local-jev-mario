import { boundedBytes, loadHostedROM } from './assets.mjs';
import { BrowserMario, bindKeyboard, sha256, validateROM } from './core.mjs';

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

function controls() {
  $('rom').disabled = busy;
  $('load-rom').disabled = busy || !manifest;
  $('replay').disabled = busy || !rom || !manifest;
  $('manual').disabled = busy || !rom;
  $('toggle').disabled = busy || mode === 'idle' || phase === 'complete';
  $('step').disabled =
    busy || playing || mode !== 'replay' || phase === 'complete';
  $('toggle').textContent = playing ? '暂停 / Pause' : '继续 / Resume';
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
  }
  const h = game.history;
  $('decision').textContent = h
    ? `输入帧 / Input frame ${h.inputFrame} · Choice ${h.answers.move.choice} · ${h.latencyMs} ms`
    : '无历史决策 / No historical decision';
  $('input').textContent = h ? JSON.stringify(h.input, null, 2) : '—';
  $('questions').textContent = h ? JSON.stringify(h.questions, null, 2) : '—';
  $('answers').textContent = h ? JSON.stringify(h.answers, null, 2) : '—';
  controls();
}

function fail(error) {
  pause();
  $('message').textContent = `停止 / Stopped: ${error.message}`;
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
    $('message').textContent =
      '完整回放已核验：6275 动作 / 32 关 / 终态像素一致。Audited victory verified.';
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
    $('message').textContent =
      mode === 'replay'
        ? '回放从 1-1 开始；可暂停读决策。Replay starts at 1-1.'
        : '点击画面后用方向键、Z/空格跳、X跑。失焦自动暂停。Focus canvas; arrows, Z/Space jump, X run.';
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
  $('state').textContent = '未加载 / Not loaded';
  render();
  busy = true;
  controls();
  $('message').textContent = hosted
    ? '正在从 Cloudflare 加载 ROM… / Loading ROM from Cloudflare…'
    : '正在读取本地 ROM… / Reading local ROM…';
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
    $('message').textContent =
      `${hosted ? 'ROM 已从 Cloudflare 加载并核验 / ROM loaded from Cloudflare and verified.' : 'ROM 已从本地加载，不上传 / ROM loaded locally, not uploaded.'} 点击“开始游戏”或“回放” / Click Start game or Replay. SHA-256: ${romHash}`;
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
  replaySpeed = replaySpeed === 1 ? 4 : replaySpeed === 4 ? 16 : 1;
  $('speed').textContent = `回放速度 / Speed ${replaySpeed}×`;
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
