// NES SMB1 RAM address facts; see README's references and supported-ROM scope.
export function readPlayer(ram) {
  if (!ram || ram.length < 0x800)
    throw new Error('Expected at least 2 KiB of NES CPU RAM.');
  const byte = (address) => {
    const value = ram[address];
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new Error(`Invalid RAM byte at ${address.toString(16)}.`);
    return value;
  };
  const digits = (start, count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const digit = byte(start + i);
      if (digit > 9)
        throw new Error('Unsupported RAM layout: invalid decimal HUD digit.');
      value = value * 10 + digit;
    }
    return value;
  };
  const state = byte(0x0e);
  const mode = byte(0x770);
  const motion = byte(0x1d);
  const dead = state === 6 || state === 11 || byte(0xb5) > 1;
  const flag = Array.from({ length: 5 }, (_, i) => byte(0x16 + i)).some(
    (type) => type === 0x31 || type === 0x2d,
  );
  const height = byte(0x754) === 0 ? 32 : 16;
  // SMB keeps a 32-pixel Y anchor even when small Mario occupies its lower half.
  const y = (byte(0xb5) - 1) * 256 + byte(0xce) + 32 - height;
  const speed = byte(0x9f);
  const verticalSpeed = speed < 128 ? speed : speed - 256;
  const grounded = motion === 0 && state === 8;
  return {
    x: byte(0x6d) * 256 + byte(0x86),
    y,
    height,
    cameraX: byte(0x71a) * 256 + byte(0x71c),
    state,
    mode,
    grounded,
    verticalSpeed,
    jumpPhase: dead
      ? 'dead'
      : grounded
        ? 'grounded'
        : motion === 3
          ? 'climbing'
          : verticalSpeed < 0
            ? 'rising'
            : verticalSpeed > 0
              ? 'falling'
              : 'apex',
    power: byte(0x756),
    world: byte(0x75f) + 1,
    stage: byte(0x75c) + 1,
    lives: byte(0x75a) === 255 ? 0 : byte(0x75a) + 1,
    time: digits(0x7f8, 3),
    score: digits(0x7de, 6),
    dead,
    clear: mode === 2 || (flag && motion === 3),
  };
}

export function tileAt(ram, worldX, screenY, cameraX) {
  // Two alternating pages form a ring buffer. Restrict to the visible window
  // so a stale page is never described to the model as an upcoming platform.
  if (
    worldX < cameraX ||
    worldX >= cameraX + 256 ||
    screenY < 32 ||
    screenY >= 240
  )
    return null;
  const page = Math.floor(worldX / 256) % 2;
  const column = Math.floor((worldX % 256) / 16);
  const row = Math.floor((screenY - 32) / 16);
  return ram[0x500 + page * 208 + row * 16 + column];
}

function terrain(ram, player) {
  const columns = [];
  const base = Math.floor(player.x / 16) * 16;
  for (let i = 0; i < 10; i++) {
    const x = base + i * 16;
    const cells = Array.from({ length: 13 }, (_, row) =>
      tileAt(ram, x + 8, 32 + row * 16, player.cameraX),
    );
    const known = cells.every((cell) => cell !== null);
    const occupiedRows = known
      ? cells.flatMap((cell, row) => (cell ? [32 + row * 16] : []))
      : null;
    columns.push({
      x,
      known,
      occupiedY: occupiedRows,
      noGroundBelow: known
        ? !occupiedRows.some((y) => y >= player.y + player.height)
        : null,
    });
  }
  const surfaces = [];
  for (let y = 32; y < 240; y += 16) {
    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].occupiedY?.includes(y)) continue;
      const startX = columns[i].x;
      while (columns[i + 1]?.occupiedY?.includes(y)) i++;
      const endX = columns[i].x + 16;
      const above = surfaces.find(
        (surface) =>
          surface.startX === startX &&
          surface.endX === endX &&
          surface.bottomY === y,
      );
      if (above) above.bottomY = y + 16;
      else surfaces.push({ startX, endX, topY: y, bottomY: y + 16 });
    }
  }
  const gaps = [];
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].noGroundBelow !== true) continue;
    const startX = columns[i].x;
    while (columns[i + 1]?.noGroundBelow === true) i++;
    gaps.push({ startX, endX: columns[i].x + 16 });
  }
  const known = columns.filter((column) => column.known);
  const blocking = surfaces
    .filter(
      (surface) =>
        surface.topY < player.y + player.height &&
        surface.bottomY > player.y &&
        surface.endX > player.x + 16,
    )
    .sort((a, b) => a.startX - b.startX)[0];
  return {
    surfaces,
    obstacleAhead: blocking
      ? {
          distancePixels: Math.max(0, blocking.startX - player.x - 16),
          startX: blocking.startX,
          endX: blocking.endX,
          topY: blocking.topY,
        }
      : null,
    possibleGaps: gaps,
    observedX: known.length ? [known[0].x, known.at(-1).x + 16] : null,
    reliability: player.grounded
      ? 'grounded_preview'
      : 'airborne_body_relative',
  };
}

const ENEMIES = {
  0: 'green_koopa',
  1: 'red_koopa',
  2: 'buzzy_beetle',
  5: 'hammer_bro',
  6: 'goomba',
  18: 'piranha',
  49: 'flagpole',
};

export class Telemetry {
  constructor(framesPerDecision) {
    this.horizon = framesPerDecision;
    this.previous = null;
    this.lastGrounded = null;
    this.bestX = 0;
    this.stalledFrames = 0;
  }

  sample(ram, frame, previousAction = null, events = {}) {
    const player = readPlayer(ram);
    const elapsed = this.previous ? frame - this.previous.frame : 0;
    if (this.previous && elapsed <= 0)
      throw new Error('Telemetry frames must advance.');
    const dx = this.previous ? player.x - this.previous.player.x : 0;
    const dy = this.previous
      ? player.y +
        player.height -
        this.previous.player.y -
        this.previous.player.height
      : 0;
    const vx = elapsed ? dx / elapsed : null;
    const vy = elapsed ? dy / elapsed : null;
    const enemies = [];
    for (let slot = 0; slot < 5; slot++) {
      if (!ram[0xf + slot]) continue;
      const kind = ram[0x16 + slot];
      const x = ram[0x6e + slot] * 256 + ram[0x87 + slot];
      const y = (ram[0xb6 + slot] - 1) * 256 + ram[0xcf + slot];
      const previous = this.previous?.enemies.find(
        (enemy) =>
          enemy.slot === slot &&
          enemy.kind === kind &&
          Math.abs(enemy.x - x) < 64,
      );
      const relativeVelocity =
        elapsed && previous ? (x - player.x - previous.dx) / elapsed : null;
      if (x < player.cameraX - 16 || x >= player.cameraX + 256) continue;
      enemies.push({
        slot,
        kind,
        name: ENEMIES[kind] ?? `object_${kind}`,
        x,
        y,
        dx: x - player.x,
        dy: y - player.y,
        relativeVelocity,
        projectedDx:
          relativeVelocity === null
            ? null
            : x - player.x + relativeVelocity * this.horizon,
        contactInFrames:
          relativeVelocity !== null && relativeVelocity < 0 && x >= player.x
            ? Math.max(0, (x - player.x - 16) / -relativeVelocity)
            : null,
      });
    }
    const currentTerrain = terrain(ram, player);
    if (player.grounded)
      this.lastGrounded = { frame, playerX: player.x, ...currentTerrain };
    this.bestX = Math.max(this.bestX, player.x);
    this.stalledFrames = elapsed && dx <= 0 ? this.stalledFrames + elapsed : 0;
    const snapshot = {
      player,
      trajectory: {
        deltaX: dx,
        deltaY: dy,
        velocityX: vx,
        velocityY: vy,
        units: 'pixels per emulator frame; positive y is down',
      },
      hazard: {
        imminentCollision: enemies.some(
          (enemy) =>
            enemy.kind !== 0x31 &&
            Math.abs(enemy.dy) < 32 &&
            enemy.dx >= 0 &&
            (enemy.dx <= 32 ||
              (enemy.contactInFrames !== null &&
                enemy.contactInFrames <= this.horizon + 16)),
        ),
        enemies,
        projection:
          'constant measured relative velocity; null means insufficient history, not safety',
      },
      terrain: {
        ...currentTerrain,
        lastGroundedPreview: player.grounded ? null : this.lastGrounded,
      },
      reaction_timing: {
        framesPerDecision: this.horizon,
        collisionLookaheadFrames: this.horizon + 16,
        inferenceDelayFrames: 0,
        emulatorPausedDuringInference: true,
      },
      recent_control: {
        action: previousAction,
        heldJump: previousAction?.includes('jump') ?? false,
        jumpReady: player.grounded && !previousAction?.includes('jump'),
        headBump: events.headBump === true,
        landed: events.landed === true,
        outcome:
          elapsed && dx === 0 ? 'no_horizontal_progress' : 'moving_or_initial',
      },
      episode: {
        frame,
        bestX: this.bestX,
        stalledFrames: this.stalledFrames,
        terminal: player.dead ? 'dead' : player.clear ? 'clear' : null,
      },
    };
    this.previous = { frame, player, enemies };
    return snapshot;
  }
}
