import { createHash } from 'node:crypto';
import { NES } from 'jsnes';
import { ACTIONS } from './policy.mjs';
import { readPlayer, tileAt } from './telemetry.mjs';

export function validateROM(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== 16 + 32768 + 8192 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x4e, 0x45, 0x53, 0x1a])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    (bytes[6] & 0xfc) !== 0 ||
    bytes[7] !== 0 ||
    (bytes[9] & 0xfe) !== 0 ||
    bytes.subarray(10, 16).some((value) => value !== 0)
  ) {
    throw new Error(
      'Expected a Super Mario Bros iNES 1.0 ROM: mapper 0, 32 KiB PRG, 8 KiB CHR, no trainer. World and Europe Rev A layouts are supported; JSNES uses NTSC timing, not accurate PAL timing. Supply your own lawfully obtained ROM; none is bundled.',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export class MarioEmulator {
  constructor() {
    this.pixels = Buffer.alloc(256 * 240 * 4);
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
  }

  release() {
    for (let button = 0; button < 8; button++) this.nes.buttonUp(1, button);
  }

  boot(bytes) {
    this.hash = validateROM(bytes);
    this.nes.loadROM(bytes.toString('latin1'));
    this.release();
    this.frame = 0;
    // Boot and press START only. No RAM writes, save state or gameplay override.
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
    throw new Error(
      'ROM did not reach playable SMB1 world 1-1. This ROM revision/layout is unsupported.',
    );
  }

  get ram() {
    return this.nes.cpu.mem;
  }

  forecast(frames) {
    const origin = readPlayer(this.ram);
    const snapshot = this.nes.toJSON();
    const horizon = 60;
    if (!this.predictor) {
      this.predictor = new MarioEmulator();
      this.predictor.nes.loadROM(this.nes.romData);
      this.predictor.nes.ui.writeFrame = () => {};
    }
    const moves = {};
    const position = (player) => [
      player.x - origin.x,
      player.y,
      player.clear ? 'clear' : player.jumpPhase,
    ];
    for (const action of Object.keys(ACTIONS)) {
      // Restore only the disposable predictor; never rewind or advance live play.
      this.predictor.nes.fromJSON(structuredClone(snapshot));
      this.predictor.frame = this.frame;
      this.predictor.advance(action, frames);
      const next = readPlayer(this.predictor.ram);
      const nextSnapshot = structuredClone(this.predictor.nes.toJSON());
      const headBump = this.predictor.lastEvents.headBump;
      if (horizon > frames) this.predictor.advance(action, horizon - frames);
      const held = readPlayer(this.predictor.ram);
      let noSurvivingFollowup = false;
      if (!next.dead && !next.clear && held.dead) {
        noSurvivingFollowup = true;
        for (const followup of Object.keys(ACTIONS)) {
          this.predictor.nes.fromJSON(structuredClone(nextSnapshot));
          this.predictor.frame = this.frame + frames;
          this.predictor.advance(followup, frames);
          if (!readPlayer(this.predictor.ram).dead) {
            noSurvivingFollowup = false;
            break;
          }
        }
      }
      moves[action] = {
        next: position(next),
        held: position(held),
        jumpReadyNext: next.grounded && !action.includes('jump'),
        ...(headBump ? { headBump: true } : {}),
        ...(noSurvivingFollowup ? { noSurvivingFollowup: true } : {}),
      };
    }
    return { frames, heldFor: horizon, moves };
  }

  advance(action, frames) {
    if (!Object.hasOwn(ACTIONS, action))
      throw new Error(`Unknown action: ${action}`);
    if (!Number.isInteger(frames) || frames < 1 || frames > 60)
      throw new Error('Invalid frame count.');
    this.release();
    this.lastEvents = { headBump: false, landed: false };
    for (const button of ACTIONS[action]) this.nes.buttonDown(1, button);
    let advanced = 0;
    while (advanced < frames) {
      const before = readPlayer(this.ram);
      if (before.dead || before.clear) break;
      this.nes.frame();
      const after = readPlayer(this.ram);
      if (!before.grounded && after.grounded) this.lastEvents.landed = true;
      if (
        before.verticalSpeed < 0 &&
        after.verticalSpeed >= 0 &&
        [after.x + 4, after.x + 12].some(
          (x) => (tileAt(this.ram, x, after.y, after.cameraX) ?? 0) !== 0,
        )
      )
        this.lastEvents.headBump = true;
      this.frame++;
      advanced++;
    }
    return advanced;
  }
}
