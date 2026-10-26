import { readPlayer } from '../telemetry.mjs';

export const ACTIONS = Object.freeze({
  noop: [],
  right: [7],
  right_jump: [7, 0],
  right_run: [7, 1],
  right_run_jump: [7, 1, 0],
  jump: [0],
  left: [6],
  down: [5],
  left_jump: [6, 0],
});

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function validateROM(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== 40976 ||
    ![0x4e, 0x45, 0x53, 0x1a, 2, 1].every((b, i) => bytes[i] === b) ||
    (bytes[6] & 0xfc) !== 0 ||
    bytes[7] !== 0 ||
    (bytes[9] & 0xfe) !== 0 ||
    bytes.subarray(10, 16).some((b) => b !== 0)
  )
    throw new Error(
      'Choose a legally obtained SMB1 mapper-0 iNES file (32 KiB PRG / 8 KiB CHR). Extract ZIP locally.',
    );
}

export class BrowserMario {
  constructor(NES) {
    this.pixels = new Uint8ClampedArray(256 * 240 * 4);
    this.nes = new NES({
      emulateSound: false,
      onFrame: (frame) => {
        for (let i = 0; i < frame.length; i++) {
          this.pixels[i * 4] = frame[i] & 255;
          this.pixels[i * 4 + 1] = (frame[i] >> 8) & 255;
          this.pixels[i * 4 + 2] = (frame[i] >> 16) & 255;
          this.pixels[i * 4 + 3] = 255;
        }
      },
    });
    this.frame = 0;
    this.count = 0;
    this.within = 0;
    this.completedLevels = [];
    this.history = null;
  }

  get player() {
    return readPlayer(this.nes.cpu.mem);
  }

  release() {
    for (let b = 0; b < 8; b++) this.nes.buttonUp(1, b);
  }

  boot(bytes) {
    validateROM(bytes);
    this.nes.loadROM(String.fromCharCode(...bytes));
    this.release();
    this.frame = 0;
    this.count = 0;
    this.within = 0;
    this.completedLevels = [];
    this.history = null;
    for (let i = 0; i < 60; i++) this.nes.frame();
    this.nes.buttonDown(1, 3);
    this.nes.frame();
    this.nes.buttonUp(1, 3);
    for (let i = 0; i < 600; i++) {
      this.nes.frame();
      const ram = this.nes.cpu.mem;
      if (
        ram[0x770] === 1 &&
        ram[0x772] === 3 &&
        ram[0x0e] === 8 &&
        ram[0x75f] === 0 &&
        ram[0x75c] === 0
      ) {
        readPlayer(ram);
        return;
      }
    }
    throw new Error('ROM did not reach the supported 1-1 opening.');
  }

  advance(event, amount = 60) {
    if (
      !Object.hasOwn(ACTIONS, event.action) ||
      !Number.isInteger(event.frames) ||
      event.frames < 1 ||
      event.frames > 60 ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 60 ||
      event.frame !== this.frame - this.within + event.frames
    )
      throw new Error('Invalid replay action/frame boundary.');
    if (!this.within && !event.automatic) {
      if (
        event.index !== this.count ||
        event.history?.inputFrame !== this.frame ||
        event.history?.answers?.move?.choice !== event.action
      )
        throw new Error('Replay Choice/input does not match the action.');
      this.history = event.history;
    }
    if (event.automatic && event.action !== 'noop')
      throw new Error('Automatic replay must release all buttons.');
    this.release();
    for (const button of ACTIONS[event.action]) this.nes.buttonDown(1, button);
    const frames = Math.min(amount, event.frames - this.within);
    for (let i = 0; i < frames; i++) {
      const p = this.player;
      if (
        event.automatic
          ? !p.automatic
          : p.dead || p.clear || p.levelClear || !p.controllable
      )
        throw new Error('Replay stopped before its recorded boundary.');
      this.nes.frame();
      this.frame++;
      this.within++;
    }
    if (this.within !== event.frames) return false;
    const player = this.player;
    for (const [key, value] of Object.entries(event.player)) {
      if (key !== 'automatic' && player[key] !== value)
        throw new Error(`Replay player.${key} differs at frame ${this.frame}.`);
    }
    const levels = event.completedLevels;
    if (
      !Array.isArray(levels) ||
      levels.length > 32 ||
      levels.length < this.completedLevels.length ||
      levels.some(
        (level, i) => level !== `${Math.floor(i / 4) + 1}-${(i % 4) + 1}`,
      )
    )
      throw new Error('Replay level order differs.');
    this.completedLevels = levels;
    if (!event.automatic) this.count++;
    this.within = 0;
    this.release();
    return true;
  }

  manualFrame(buttons) {
    this.release();
    for (const button of buttons) this.nes.buttonDown(1, button);
    this.nes.frame();
    this.frame++;
  }

  async verifyTerminal(manifest) {
    const pixelSHA256 = await sha256(this.pixels);
    if (
      this.frame !== manifest.totalFrames ||
      this.count !== manifest.totalDecisions ||
      this.completedLevels.length !== 32 ||
      !this.player.clear ||
      pixelSHA256 !== manifest.pixelSHA256
    )
      throw new Error('Terminal replay does not match the audited victory.');
    return pixelSHA256;
  }
}

export const KEY_BUTTONS = Object.freeze({
  ArrowRight: 7,
  ArrowLeft: 6,
  ArrowDown: 5,
  ArrowUp: 4,
  KeyZ: 0,
  Space: 0,
  KeyX: 1,
  Enter: 3,
  ShiftRight: 2,
});

export function bindKeyboard(target, canvas, game, onBlur) {
  const keys = new Set();
  const release = () => {
    keys.clear();
    game.release();
    onBlur();
  };
  target.addEventListener('keydown', (event) => {
    if (target.document.activeElement !== canvas) return;
    if (Object.hasOwn(KEY_BUTTONS, event.code)) {
      event.preventDefault();
      keys.add(event.code);
    }
  });
  target.addEventListener('keyup', (event) => {
    keys.delete(event.code);
  });
  target.addEventListener('blur', release);
  target.addEventListener('pagehide', release);
  canvas.addEventListener('blur', release);
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.hidden) release();
  });
  return {
    buttons: () => new Set([...keys].map((key) => KEY_BUTTONS[key])),
    release,
  };
}
