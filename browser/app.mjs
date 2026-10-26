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
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-cache',
  });
  if (!response.ok) throw new Error(`Static data HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Static data exceeds its size limit.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
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

$('rom').addEventListener('change', async () => {
  pause();
  keyboard.release();
  mode = 'idle';
  rom = null;
  romHash = null;
  busy = true;
  controls();
  try {
    const file = $('rom').files[0];
    if (!file || file.size !== 40976)
      throw new Error('Choose a 40976-byte .nes file, not ZIP.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateROM(bytes);
    romHash = await sha256(bytes);
    rom = bytes;
    $('message').textContent =
      `ROM 已加载，仅在此浏览器内存。点击“开始游戏”或“回放”。ROM loaded locally; click Start game or Replay. SHA-256: ${romHash}`;
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
  }
});
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
