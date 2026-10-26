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
  const task = byte(0x772);
  const motion = byte(0x1d);
  const world = byte(0x75f) + 1;
  const stage = byte(0x75c) + 1;
  const gameOver = mode === 3 || byte(0x75a) === 255;
  const dead =
    gameOver ||
    (mode === 1 &&
      (state === 6 || state === 11 || (state === 8 && byte(0xb5) > 1)));
  const flag = Array.from({ length: 5 }, (_, i) => i).some(
    (i) => byte(0xf + i) !== 0 && byte(0x16 + i) === 0x31,
  );
  const levelClear =
    !dead && (mode === 2 || (flag && motion === 3 && state === 4));
  const clear = !dead && mode === 2 && world === 8 && stage === 4;
  const controllable =
    !dead && mode === 1 && task === 3 && [8, 10].includes(state);
  const height = byte(0x754) === 0 ? 32 : 16;
  // SMB keeps a 32-pixel Y anchor even when small Mario occupies its lower half.
  const y = (byte(0xb5) - 1) * 256 + byte(0xce) + 32 - height;
  const speed = byte(0x9f);
  const verticalSpeed = speed < 128 ? speed : speed - 256;
  const grounded = controllable && motion === 0 && state === 8;
  const swimming = byte(0x704) !== 0;
  // The swim restart timer decrements before input is processed.
  const jumpAvailable =
    controllable &&
    (grounded || (swimming && (byte(0x782) > 1 || verticalSpeed >= 0)));
  return {
    x: byte(0x6d) * 256 + byte(0x86),
    y,
    height,
    cameraX: byte(0x71a) * 256 + byte(0x71c),
    state,
    mode,
    task,
    controllable,
    automatic: !gameOver && !clear && !controllable && [1, 2].includes(mode),
    area: byte(0x760) + 1,
    areaPointer: byte(0x750),
    areaDataAddress: byte(0xe7) + 256 * byte(0xe8),
    grounded,
    swimming,
    jumpAvailable,
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
    world,
    stage,
    lives: byte(0x75a) === 255 ? 0 : byte(0x75a) + 1,
    time: digits(0x7f8, 3),
    score: digits(0x7de, 6),
    dead,
    gameOver,
    levelClear,
    clear,
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

export const isHiddenBlock = (tile) => tile === 0x5f || tile === 0x60;
const isNonSolidTile = (tile) => tile === 0 || isHiddenBlock(tile);

function terrain(ram, player, lookBehind = false) {
  const columns = [];
  const hiddenBlocks = [];
  const supportBlocks = [];
  const base = Math.floor(player.x / 16) * 16 - (lookBehind ? 64 : 0);
  for (let i = 0; i < (lookBehind ? 14 : 10); i++) {
    const x = base + i * 16;
    const cells = Array.from({ length: 13 }, (_, row) =>
      tileAt(ram, x + 8, 32 + row * 16, player.cameraX),
    );
    const known = cells.every((cell) => cell !== null);
    for (const [row, cell] of cells.entries()) {
      if (isHiddenBlock(cell)) hiddenBlocks.push({ x, y: 32 + row * 16 });
      if (cell === 0x23 || cell === 0xc4)
        supportBlocks.push({
          startX: x,
          endX: x + 16,
          topY: 32 + row * 16,
          ready: cell === 0xc4,
        });
    }
    const occupiedRows = known
      ? cells.flatMap((cell, row) =>
          !isNonSolidTile(cell) ? [32 + row * 16] : [],
        )
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
  const pipeTops = [];
  for (let y = 32; y < 240; y += 16) {
    for (const { x } of columns) {
      if (
        tileAt(ram, x, y, player.cameraX) === 0x10 &&
        tileAt(ram, x + 16, y, player.cameraX) === 0x11
      )
        pipeTops.push({ startX: x, endX: x + 32, topY: y });
    }
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
    pipeTops,
    hiddenBlocks,
    supportBlocks,
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
  36: 'moving_platform',
  49: 'flagpole',
  50: 'springboard',
};

export function sameNavigationPosition(a, b) {
  // Horizontal collision rounding can alternate by one pixel.
  return Math.abs(a.x - b.x) <= 1 && a.y === b.y;
}

function observedFloorSegments(observedFloors, gateX) {
  const column = Math.floor((gateX + 8) / 16) * 16;
  return [...observedFloors]
    .filter(([, tiles]) => tiles.has(column))
    .map(([topY, tiles]) => {
      let startX = column;
      let endX = column + 16;
      while (tiles.has(startX - 16)) startX -= 16;
      while (tiles.has(endX)) endX += 16;
      return { topY, startX, endX };
    });
}

export function springboardNearby(ram, player) {
  return [0, 1, 2, 3, 4].some(
    (slot) =>
      ram[0xf + slot] !== 0 &&
      ram[0x16 + slot] === 0x32 &&
      Math.abs(ram[0x6e + slot] * 256 + ram[0x87 + slot] - player.x) < 64,
  );
}

export function narrowSupportContext(
  ram,
  player,
  observedLoopCount,
  observedTerrain = terrain(ram, player, observedLoopCount > 0),
) {
  const nearby =
    observedLoopCount > 0 &&
    observedTerrain.pipeTops.length > 0 &&
    (observedTerrain.hiddenBlocks.some(
      (block) => Math.abs(block.x - player.x) <= 64,
    ) ||
      observedTerrain.supportBlocks.some(
        (block) => block.topY > 32 && Math.abs(block.startX - player.x) <= 64,
      ));
  return {
    nearby,
    frameCap: springboardNearby(ram, player) ? 4 : 8,
    supports: nearby
      ? observedTerrain.supportBlocks.filter(
          (block) =>
            block.topY > 32 &&
            Math.abs(block.startX - player.x) <= 64 &&
            (!player.grounded || block.topY < player.y + player.height),
        )
      : [],
  };
}

export class Telemetry {
  constructor(framesPerDecision) {
    this.horizon = framesPerDecision;
    this.previous = null;
    this.lastGrounded = null;
    this.bestX = 0;
    this.stalledFrames = 0;
    this.completedLevels = new Set();
    this.activeLevel = null;
    this.blockedPositions = [];
    this.mazeRoute = null;
    this.runJumpTargetX = undefined;
    this.observedFloors = new Map();
    this.mazeCheckpoints = [];
    this.passedMazePages = new Set();
    this.observedLoopCount = 0;
  }

  sample(ram, frame, previousAction = null, events = {}) {
    const player = readPlayer(ram);
    const nearSpringboard = springboardNearby(ram, player);
    const elapsed = this.previous ? frame - this.previous.frame : 0;
    if (this.previous && elapsed <= 0)
      throw new Error('Telemetry frames must advance.');
    const level = `${player.world}-${player.stage}`;
    const areaChanged =
      this.previous &&
      (player.world !== this.previous.player.world ||
        player.stage !== this.previous.player.stage ||
        player.area !== this.previous.player.area ||
        player.areaDataAddress !== this.previous.player.areaDataAddress);
    const lifeChanged =
      this.previous && player.lives !== this.previous.player.lives;
    const comparable =
      this.previous &&
      !areaChanged &&
      !lifeChanged &&
      player.controllable &&
      this.previous.player.controllable;
    if (areaChanged || lifeChanged) {
      this.lastGrounded = null;
      this.bestX = player.x;
      this.stalledFrames = 0;
      this.mazeRoute = null;
      this.runJumpTargetX = undefined;
      this.observedFloors.clear();
      this.mazeCheckpoints = [];
      this.passedMazePages.clear();
      this.observedLoopCount = 0;
    }
    if (events.mazeReset && !areaChanged && !lifeChanged)
      this.observedLoopCount++;
    const currentTerrain = terrain(ram, player, this.observedLoopCount > 0);
    const narrow = narrowSupportContext(
      ram,
      player,
      this.observedLoopCount,
      currentTerrain,
    );
    const narrowBlockNearby = narrow.nearby;
    const narrowSupports = narrow.supports;
    const nonTileSupport =
      !player.swimming &&
      (player.grounded
        ? isNonSolidTile(
            tileAt(ram, player.x + 8, player.y + player.height, player.cameraX),
          )
        : this.lastGrounded?.spriteSupported === true);
    const horizon = Math.min(
      this.horizon,
      player.swimming || nonTileSupport ? 8 : this.horizon,
      nearSpringboard ? 4 : this.horizon,
      narrowBlockNearby ? narrow.frameCap : this.horizon,
    );
    if (player.controllable) {
      if (
        player.world < 1 ||
        player.world > 8 ||
        player.stage < 1 ||
        player.stage > 4
      )
        throw new Error(
          `Unsupported RAM layout: invalid playable level ${level}.`,
        );
      this.activeLevel = level;
    }
    if (player.levelClear && level === this.activeLevel)
      this.completedLevels.add(level);
    const dx = comparable ? player.x - this.previous.player.x : 0;
    if (comparable) {
      for (const event of events.mazeCheckpoints ?? []) {
        let checkpoint = this.mazeCheckpoints.find(
          (point) => point.page === event.page,
        );
        if (!checkpoint) {
          checkpoint = {
            page: event.page,
            gateX: event.x,
            ordinal: event.ordinal,
            correctFloorYs: [],
            failedFloorYs: [],
          };
          this.mazeCheckpoints.push(checkpoint);
        }
        checkpoint.gateX = event.x;
        checkpoint.lastResult = event.correct;
        if (event.floorY !== null && event.correct !== null) {
          const list = event.correct
            ? checkpoint.correctFloorYs
            : checkpoint.failedFloorYs;
          if (!list.includes(event.floorY)) list.push(event.floorY);
        }
        this.passedMazePages.add(event.page);
        if (event.sequenceEnded && !event.sequenceCorrect)
          this.passedMazePages.clear();
      }
    }
    if (
      comparable &&
      events.mazeReset?.grounded &&
      !player.swimming &&
      !(player.world === 7 && player.stage === 4)
    ) {
      const prior = this.previous.player;
      const segments = observedFloorSegments(
        this.observedFloors,
        events.mazeReset.x,
      );
      const floors = segments.map((floor) => floor.topY);
      const feet = events.mazeReset.feet;
      const failedFloor = floors.toSorted(
        (a, b) => Math.abs(a - feet) - Math.abs(b - feet),
      )[0];
      if (failedFloor !== undefined && Math.abs(failedFloor - feet) <= 16) {
        const repeated =
          this.mazeRoute && Math.abs(this.mazeRoute.gateX - prior.x) < 128;
        const failedFloorYs = [
          ...new Set([
            ...(repeated ? this.mazeRoute.failedFloorYs : []),
            failedFloor,
          ]),
        ];
        this.mazeRoute = {
          gateX: events.mazeReset.x,
          failedFloorYs,
          alternativeFloorYs: [...new Set(floors)].filter(
            (floor) => !failedFloorYs.includes(floor),
          ),
        };
        this.mazeRoute.alternativeFloors = segments.filter((floor) =>
          this.mazeRoute.alternativeFloorYs.includes(floor.topY),
        );
      }
    }
    if (this.mazeRoute && player.x > this.mazeRoute.gateX + 64)
      this.mazeRoute = null;
    const dy = comparable
      ? player.y +
        player.height -
        this.previous.player.y -
        this.previous.player.height
      : 0;
    if (areaChanged || lifeChanged || player.automatic)
      this.blockedPositions = [];
    if (
      comparable &&
      player.grounded &&
      (this.previous.player.grounded || events.landed) &&
      (previousAction?.startsWith('right') ||
        previousAction?.startsWith('left')) &&
      (previousAction.startsWith('left') ? dx <= 0 : dx >= 0) &&
      (dy === 0 || events.landed) &&
      !isNonSolidTile(
        tileAt(
          ram,
          player.x + (previousAction.startsWith('left') ? -1 : 16),
          player.y + player.height / 2,
          player.cameraX,
        ) ?? 0,
      )
    ) {
      const position = { x: player.x, y: player.y };
      this.blockedPositions = [
        ...this.blockedPositions.filter(
          (prior) => !sameNavigationPosition(prior, position),
        ),
        position,
      ].slice(-4);
    }
    const vx = comparable && elapsed ? dx / elapsed : null;
    const vy = comparable && elapsed ? dy / elapsed : null;
    const enemies = [];
    for (let slot = 0; slot < 5; slot++) {
      if (!ram[0xf + slot]) continue;
      const kind = ram[0x16 + slot];
      const x = ram[0x6e + slot] * 256 + ram[0x87 + slot];
      const y = (ram[0xb6 + slot] - 1) * 256 + ram[0xcf + slot];
      const previous =
        comparable &&
        this.previous.enemies.find(
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
            : x - player.x + relativeVelocity * horizon,
        contactInFrames:
          relativeVelocity !== null && relativeVelocity < 0 && x >= player.x
            ? Math.max(0, (x - player.x - 16) / -relativeVelocity)
            : null,
      });
    }
    if (player.controllable) {
      for (
        let x = Math.floor(player.x / 16) * 16;
        x < player.x + 144;
        x += 16
      ) {
        for (let y = 48; y < 240; y += 16) {
          const cell = tileAt(ram, x + 8, y, player.cameraX);
          const above = tileAt(ram, x + 8, y - 16, player.cameraX);
          if (cell === null || above === null) continue;
          if (!this.observedFloors.has(y))
            this.observedFloors.set(y, new Set());
          const tiles = this.observedFloors.get(y);
          if (!isNonSolidTile(cell) && isNonSolidTile(above)) tiles.add(x);
          else tiles.delete(x);
        }
      }
      if (this.mazeCheckpoints.length) {
        const target = this.mazeCheckpoints
          .filter(
            (point) =>
              !this.passedMazePages.has(point.page) &&
              point.gateX >= player.x - 32,
          )
          .toSorted((a, b) => a.gateX - b.gateX)[0];
        this.mazeRoute = null;
        if (target) {
          const segments = observedFloorSegments(
            this.observedFloors,
            target.gateX,
          );
          const alternatives = segments.filter((floor) =>
            target.correctFloorYs.length
              ? target.correctFloorYs.includes(floor.topY)
              : !target.failedFloorYs.includes(floor.topY),
          );
          this.mazeRoute = {
            gateX: target.gateX,
            checkpointPage: target.page,
            failedFloorYs: [...target.failedFloorYs],
            alternativeFloorYs: alternatives.map((floor) => floor.topY),
            alternativeFloors: alternatives,
            ...(segments.length
              ? {}
              : { unknown: 'No exposed floor observed at this checkpoint.' }),
          };
        }
      }
    }
    if (player.grounded)
      this.lastGrounded = {
        frame,
        playerX: player.x,
        playerFeet: player.y + player.height,
        spriteSupported:
          !player.swimming &&
          isNonSolidTile(
            tileAt(ram, player.x + 8, player.y + player.height, player.cameraX),
          ),
        ...currentTerrain,
      };
    const advancesBest = player.x > this.bestX;
    this.bestX = Math.max(this.bestX, player.x);
    this.stalledFrames =
      comparable && elapsed && !advancesBest ? this.stalledFrames + elapsed : 0;
    const hasMazeLandingTarget = Boolean(
      this.mazeRoute?.alternativeFloors.length,
    );
    const climbFloors =
      !player.swimming &&
      !hasMazeLandingTarget &&
      (this.stalledFrames >= 180 ||
        this.blockedPositions.some((position) =>
          sameNavigationPosition(position, player),
        ))
        ? currentTerrain.surfaces
            .filter(
              (surface) =>
                surface.topY > 32 &&
                surface.topY < this.lastGrounded?.playerFeet &&
                surface.endX >
                  player.x +
                    (this.observedLoopCount && currentTerrain.pipeTops.length
                      ? -64
                      : 8),
            )
            .map(({ topY, startX, endX }) => ({ topY, startX, endX }))
        : [];
    if (
      player.swimming ||
      hasMazeLandingTarget ||
      !player.controllable ||
      (player.grounded && player.x + 8 >= this.runJumpTargetX)
    )
      this.runJumpTargetX = undefined;
    if (
      this.runJumpTargetX === undefined &&
      !player.swimming &&
      !hasMazeLandingTarget &&
      player.controllable &&
      (this.stalledFrames >= 180 || this.lastGrounded?.spriteSupported)
    )
      this.runJumpTargetX = (
        !player.grounded && this.lastGrounded?.spriteSupported
          ? this.lastGrounded.possibleGaps
          : currentTerrain.possibleGaps
      ).find(
        (gap) =>
          gap.endX > player.x + 8 &&
          (gap.startX >= player.x || this.lastGrounded?.spriteSupported) &&
          gap.startX - player.x <= 128,
      )?.endX;
    const runJumpTargetX = this.runJumpTargetX;
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
            ![0x24, 0x31, 0x32].includes(enemy.kind) &&
            Math.abs(enemy.dy) < 32 &&
            enemy.dx >= 0 &&
            (enemy.dx <= 32 ||
              (enemy.contactInFrames !== null &&
                enemy.contactInFrames <= horizon + 16)),
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
        framesPerDecision: horizon,
        ...(narrowBlockNearby ? { narrowBlockControl: true } : {}),
        collisionLookaheadFrames: horizon + 16,
        inferenceDelayFrames: 0,
        emulatorPausedDuringInference: true,
      },
      recent_control: {
        action: previousAction,
        heldJump: previousAction?.includes('jump') ?? false,
        jumpReady: player.jumpAvailable && !previousAction?.includes('jump'),
        headBump: events.headBump === true,
        landed: events.landed === true,
        outcome:
          elapsed && dx === 0 ? 'no_horizontal_progress' : 'moving_or_initial',
      },
      navigation: {
        ...(narrowSupports.length ? { narrowSupports } : {}),
        ...(this.observedLoopCount
          ? { observedLoopCount: this.observedLoopCount }
          : {}),
        blockedPositions: this.blockedPositions,
        ...(this.mazeRoute ? { mazeRoute: this.mazeRoute } : {}),
        ...(this.mazeCheckpoints.length
          ? {
              mazeFeedback: {
                checkedInSequence: ram[0x6da],
                correctInSequence: ram[0x6d9],
                resetCanReflectEarlierFailure: true,
                checkpoints: structuredClone(this.mazeCheckpoints),
              },
            }
          : {}),
        ...(climbFloors.length ? { climbFloors } : {}),
        ...((this.lastGrounded?.spriteSupported || climbFloors.length) &&
        !player.swimming
          ? { higherLandingY: this.lastGrounded.playerFeet - 16 }
          : {}),
        ...(runJumpTargetX !== undefined ? { runJumpTargetX } : {}),
      },
      episode: {
        frame,
        bestX: this.bestX,
        stalledFrames: this.stalledFrames,
        terminal: player.dead
          ? 'dead'
          : player.clear
            ? this.completedLevels.size === 32
              ? 'clear'
              : 'incomplete'
            : null,
      },
      campaign: {
        goal: 'Complete all 32 levels from 1-1 through 8-4 without warps.',
        totalLevels: 32,
        completedLevels: [...this.completedLevels],
        currentLevel: level,
        areaChanged: Boolean(areaChanged),
      },
    };
    this.previous = { frame, player, enemies, terrain: currentTerrain };
    return snapshot;
  }
}
