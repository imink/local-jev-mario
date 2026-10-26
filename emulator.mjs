import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { NES } from 'jsnes';
import { ACTIONS } from './policy.mjs';
import {
  isHiddenBlock,
  narrowSupportContext,
  readPlayer,
  tileAt,
} from './telemetry.mjs';

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

  forecast(
    frames,
    {
      mazeFloors = [],
      mazeSteppingFloors = [],
      climbFloors = [],
      higherLandingY,
      runJumpTargetX,
      probePipeEntry = false,
      hiddenBlocks = [],
      narrowSupports = [],
      configuredFrames = frames,
    } = {},
  ) {
    if (
      !Number.isInteger(configuredFrames) ||
      configuredFrames < 1 ||
      configuredFrames > 60
    )
      throw new Error('Invalid configured control cadence.');
    if (runJumpTargetX !== undefined && !Number.isFinite(runJumpTargetX))
      throw new Error('Invalid run-jump landing target.');
    if (higherLandingY !== undefined && !Number.isFinite(higherLandingY))
      throw new Error('Invalid higher landing target.');
    if (
      !Array.isArray(mazeFloors) ||
      !Array.isArray(mazeSteppingFloors) ||
      !Array.isArray(climbFloors) ||
      !Array.isArray(narrowSupports) ||
      [
        ...mazeFloors,
        ...mazeSteppingFloors,
        ...climbFloors,
        ...narrowSupports,
      ].some(
        (floor) =>
          !floor ||
          !Number.isFinite(floor.topY) ||
          !Number.isFinite(floor.startX) ||
          !Number.isFinite(floor.endX) ||
          floor.startX >= floor.endX,
      )
    )
      throw new Error('Invalid observed maze floor heights.');
    const origin = readPlayer(this.ram);
    if (
      narrowSupports.some(
        (floor) =>
          floor.endX - floor.startX !== 16 ||
          ![0x23, 0xc4].includes(
            tileAt(this.ram, floor.startX, floor.topY, origin.cameraX),
          ),
      )
    )
      throw new Error('Invalid observed narrow support.');
    if (
      !Array.isArray(hiddenBlocks) ||
      hiddenBlocks.some(
        (block) =>
          !block ||
          !Number.isFinite(block.x) ||
          !Number.isFinite(block.y) ||
          !isHiddenBlock(tileAt(this.ram, block.x, block.y, origin.cameraX)),
      )
    )
      throw new Error('Invalid observed hidden block.');
    const snapshot = this.nes.toJSON();
    const horizon = 60;
    const continuationFrames = frames * Math.ceil(16 / frames);
    const supportSamplingFrames = Math.min(configuredFrames, 8);
    const supportValidationFrames =
      supportSamplingFrames *
      Math.ceil((2 * continuationFrames) / supportSamplingFrames);
    const supportPreparationFrames = Math.min(
      3 * continuationFrames,
      5 * continuationFrames - supportValidationFrames,
    );
    const runJumpHorizon = frames + 6 * continuationFrames + horizon;
    if (!this.predictor) {
      this.predictor = new MarioEmulator();
      this.predictor.nes.loadROM(this.nes.romData);
      this.predictor.nes.ui.writeFrame = () => {};
    }
    const moves = {};
    // These complete snapshots stay immutable during this synchronous forecast.
    // Cache encoding only; every restore decodes an independent mutable copy.
    const encodedSnapshots = new WeakMap();
    const restoreSnapshot = (snapshot) => {
      if (!encodedSnapshots.has(snapshot))
        encodedSnapshots.set(snapshot, serialize(snapshot));
      this.predictor.nes.fromJSON(deserialize(encodedSnapshots.get(snapshot)));
    };
    const landsOn = (player, floors) =>
      !player.dead &&
      player.grounded &&
      floors.some(
        (floor) =>
          floor.topY === player.y + player.height &&
          player.x + 8 >= floor.startX &&
          player.x + 8 < floor.endX,
      );
    const landsHigher = (player) =>
      higherLandingY !== undefined &&
      !player.dead &&
      player.grounded &&
      player.y + player.height <= higherLandingY;
    const position = (player) => [
      player.x - origin.x,
      player.y,
      player.dead
        ? 'dead'
        : player.clear
          ? 'clear'
          : player.levelClear
            ? 'level_clear'
            : player.automatic
              ? 'transition'
              : player.jumpPhase,
    ];
    // An alive falling pose can already be doomed; require a usable decision
    // boundary with jump/stroke rearmed, or a nonfatal engine transition.
    const readyForNextChoice = (player, action) =>
      !player.dead &&
      (!player.controllable ||
        (player.jumpAvailable && !action.includes('jump')));
    const survives = (
      snapshot,
      intervals,
      frame,
      intervalFrames = frames,
      requireReady = false,
    ) => {
      for (const action of Object.keys(ACTIONS)) {
        restoreSnapshot(snapshot);
        this.predictor.frame = frame;
        this.predictor.advance(action, intervalFrames);
        const player = readPlayer(this.predictor.ram);
        if (player.dead) continue;
        if (!player.controllable) return true;
        if (intervals === 1) {
          if (!requireReady || readyForNextChoice(player, action)) return true;
          continue;
        }
        if (
          survives(
            structuredClone(this.predictor.nes.toJSON()),
            intervals - 1,
            this.predictor.frame,
            intervalFrames,
            requireReady,
          )
        )
          return true;
      }
      return false;
    };
    // Early boundaries must still cover at least three future physical intervals.
    const readyBoundarySurvives = (snapshot, frame) =>
      survives(
        snapshot,
        frame - this.frame - frames < continuationFrames ? 3 : 2,
        frame,
        continuationFrames,
        true,
      );
    for (const action of Object.keys(ACTIONS)) {
      // Restore only the disposable predictor; never rewind or advance live play.
      restoreSnapshot(snapshot);
      this.predictor.frame = this.frame;
      this.predictor.advance(action, frames);
      const nextFrame = this.predictor.frame;
      const next = readPlayer(this.predictor.ram);
      const nextSnapshot = structuredClone(this.predictor.nes.toJSON());
      const headBump = this.predictor.lastEvents.headBump;
      const nextHighestY = this.predictor.lastEvents.highestY;
      const nextMazeReset = this.predictor.lastEvents.mazeReset;
      const nextChecks = this.predictor.lastEvents.mazeCheckpoints ?? [];
      const mazeCheckpointFailedNext = nextChecks.some(
        (check) => check.correct === false,
      );
      if (horizon > frames) this.predictor.advance(action, horizon - frames);
      const heldChecks =
        horizon > frames
          ? (this.predictor.lastEvents.mazeCheckpoints ?? [])
          : [];
      const mazeCheckpointFailedHeld =
        mazeCheckpointFailedNext ||
        heldChecks.some((check) => check.correct === false);
      const held = readPlayer(this.predictor.ram);
      const highestY = Math.min(
        nextHighestY ?? next.y,
        this.predictor.lastEvents.highestY ?? held.y,
      );
      const repeatsMaze = Boolean(
        nextMazeReset || this.predictor.lastEvents.mazeReset,
      );
      const nativeSequenceReset = [...nextChecks, ...heldChecks].some(
        (check) => check.sequenceEnded && check.sequenceCorrect === false,
      );
      const groundedMazeReset =
        !nativeSequenceReset &&
        [nextMazeReset, this.predictor.lastEvents.mazeReset].some(
          (reset) =>
            reset?.grounded &&
            mazeFloors.some(
              (floor) =>
                floor.topY === reset.feet &&
                reset.x + 8 >= floor.startX &&
                reset.x + 8 < floor.endX,
            ),
        );
      const entersArea = [next, held].some(
        (player) => [1, 2, 3, 7].includes(player.state) && player.automatic,
      );
      let areaDestination;
      let returnsWithinArea = false;
      if (entersArea) {
        let automaticFrames = 0;
        while (
          readPlayer(this.predictor.ram).automatic &&
          automaticFrames < 6000
        )
          automaticFrames += this.predictor.advanceTransition();
        const destination = readPlayer(this.predictor.ram);
        if (destination.automatic)
          throw new Error(
            'Pipe destination forecast exceeded 6000 automatic frames.',
          );
        areaDestination = [destination.world, destination.stage];
        returnsWithinArea =
          destination.controllable &&
          destination.world === origin.world &&
          destination.stage === origin.stage &&
          destination.areaDataAddress === origin.areaDataAddress &&
          destination.x < origin.x;
      }
      let survivesWithOneReplan =
        readyForNextChoice(next, action) &&
        (!held.dead ||
          readyBoundarySurvives(nextSnapshot, this.frame + frames));
      if (!survivesWithOneReplan && !next.dead) {
        let prefixSnapshot = nextSnapshot;
        const releaseDelays = action.includes('jump')
          ? 1 + (2 * continuationFrames) / frames
          : 1;
        for (let delay = 0; delay < releaseDelays; delay++) {
          for (const followup of Object.keys(ACTIONS)) {
            if (delay && followup.includes('jump')) continue;
            restoreSnapshot(prefixSnapshot);
            this.predictor.frame = this.frame + frames + frames * delay;
            for (
              let elapsed = 0;
              elapsed < 3 * continuationFrames - frames * delay;
              elapsed += frames
            ) {
              this.predictor.advance(followup, frames);
              const candidate = readPlayer(this.predictor.ram);
              if (candidate.dead) break;
              if (readyForNextChoice(candidate, followup)) {
                if (!held.dead) {
                  survivesWithOneReplan = true;
                  break;
                }
                const boundary = structuredClone(this.predictor.nes.toJSON());
                const boundaryFrame = this.predictor.frame;
                const remainsViable = readyBoundarySurvives(
                  boundary,
                  boundaryFrame,
                );
                restoreSnapshot(boundary);
                this.predictor.frame = boundaryFrame;
                if (remainsViable) {
                  survivesWithOneReplan = true;
                  break;
                }
              }
            }
            if (survivesWithOneReplan) break;
          }
          if (survivesWithOneReplan) break;
          if (delay + 1 === releaseDelays) break;
          // Keep A held until a later boundary, then spend the one change on release.
          restoreSnapshot(prefixSnapshot);
          this.predictor.frame = this.frame + frames + frames * delay;
          this.predictor.advance(action, frames);
          const continued = readPlayer(this.predictor.ram);
          if (continued.dead) break;
          if (!continued.controllable) {
            survivesWithOneReplan = true;
            break;
          }
          prefixSnapshot = structuredClone(this.predictor.nes.toJSON());
        }
      }
      const reachesMazeFloor = (player) =>
        !player.dead &&
        player.grounded &&
        (mazeFloors.some(
          (floor) =>
            floor.topY === player.y + player.height &&
            ((player.x >= origin.x &&
              player.y + player.height !== origin.y + origin.height) ||
              (player.x + 8 >= floor.startX && player.x + 8 < floor.endX)),
        ) ||
          (player.x >= origin.x &&
            player.y + player.height !== origin.y + origin.height &&
            landsOn(player, mazeSteppingFloors)));
      let mazeLanding =
        !mazeCheckpointFailedNext &&
        (groundedMazeReset ||
          (mazeFloors.length > 0 &&
            !repeatsMaze &&
            (reachesMazeFloor(next) ||
              (!mazeCheckpointFailedHeld && reachesMazeFloor(held)))));
      let mazeConnectedLanding =
        !mazeCheckpointFailedNext &&
        (groundedMazeReset ||
          (!repeatsMaze &&
            (landsOn(next, mazeFloors) ||
              (!mazeCheckpointFailedHeld && landsOn(held, mazeFloors)))));
      let climbLanding =
        !repeatsMaze &&
        (landsOn(next, climbFloors) ||
          landsOn(held, climbFloors) ||
          landsHigher(next) ||
          landsHigher(held));
      const landingWitnessesFound = () =>
        (!mazeFloors.length || mazeConnectedLanding) &&
        ((!climbFloors.length && higherLandingY === undefined) || climbLanding);
      if (!landingWitnessesFound() && !next.dead && !nextMazeReset) {
        for (const followup of Object.keys(ACTIONS)) {
          restoreSnapshot(nextSnapshot);
          this.predictor.frame = this.frame + frames;
          let mazePathFailed = mazeCheckpointFailedNext;
          for (let interval = 0; interval < 3; interval++) {
            this.predictor.advance(followup, continuationFrames);
            const candidate = readPlayer(this.predictor.ram);
            if (candidate.dead || this.predictor.lastEvents.mazeReset) break;
            mazePathFailed ||= (
              this.predictor.lastEvents.mazeCheckpoints ?? []
            ).some((check) => check.correct === false);
            if (!mazePathFailed && reachesMazeFloor(candidate)) {
              mazeLanding = true;
            }
            if (!mazePathFailed && landsOn(candidate, mazeFloors))
              mazeConnectedLanding = true;
            if (landsOn(candidate, climbFloors) || landsHigher(candidate))
              climbLanding = true;
            if (
              !climbLanding &&
              (climbFloors.length || higherLandingY !== undefined) &&
              followup.includes('jump') &&
              candidate.controllable &&
              interval < 2
            ) {
              const boundary = structuredClone(this.predictor.nes.toJSON());
              const boundaryFrame = this.predictor.frame;
              for (const release of Object.keys(ACTIONS)) {
                if (release.includes('jump')) continue;
                restoreSnapshot(boundary);
                this.predictor.frame = boundaryFrame;
                for (let rest = interval + 1; rest < 3; rest++) {
                  this.predictor.advance(release, continuationFrames);
                  const landing = readPlayer(this.predictor.ram);
                  if (landing.dead || this.predictor.lastEvents.mazeReset)
                    break;
                  if (landsOn(landing, climbFloors) || landsHigher(landing)) {
                    climbLanding = true;
                    break;
                  }
                  if (!landing.controllable) break;
                }
                if (climbLanding) break;
              }
              restoreSnapshot(boundary);
              this.predictor.frame = boundaryFrame;
            }
            if (landingWitnessesFound()) break;
            if (!candidate.controllable) break;
          }
          if (landingWitnessesFound()) break;
        }
      }
      const noSurvivingFollowup =
        !next.dead &&
        !next.clear &&
        held.dead &&
        !survives(nextSnapshot, 2, this.frame + frames);
      let runJumpLanding = false;
      if (runJumpTargetX !== undefined && !next.dead && !nextMazeReset) {
        const usableRunJumpLanding = (landing) => {
          if (
            landing.dead ||
            !landing.grounded ||
            landing.x + 8 < runJumpTargetX ||
            this.predictor.frame + 2 * continuationFrames >
              this.frame + runJumpHorizon
          )
            return false;
          const boundary = structuredClone(this.predictor.nes.toJSON());
          const boundaryFrame = this.predictor.frame;
          const usable = survives(
            boundary,
            2,
            boundaryFrame,
            continuationFrames,
            true,
          );
          restoreSnapshot(boundary);
          this.predictor.frame = boundaryFrame;
          return usable;
        };
        let prefixSnapshot = nextSnapshot;
        for (let prefix = 0; prefix < 4 && !runJumpLanding; prefix++) {
          for (let run = 0; run < 4 && !runJumpLanding; run++) {
            restoreSnapshot(prefixSnapshot);
            this.predictor.frame =
              this.frame + frames + continuationFrames * prefix;
            for (let interval = 0; interval < run; interval++)
              this.predictor.advance('right_run', continuationFrames);
            const launch = readPlayer(this.predictor.ram);
            if (launch.dead || !launch.controllable) continue;
            for (let elapsed = 0; elapsed < horizon && !runJumpLanding; ) {
              const interval = Math.min(frames, horizon - elapsed);
              this.predictor.advance('right_run_jump', interval);
              elapsed += interval;
              const landing = readPlayer(this.predictor.ram);
              if (landing.dead || this.predictor.lastEvents.mazeReset) break;
              runJumpLanding = usableRunJumpLanding(landing);
              if (
                !runJumpLanding &&
                landing.controllable &&
                elapsed < horizon
              ) {
                const boundary = structuredClone(this.predictor.nes.toJSON());
                const boundaryFrame = this.predictor.frame;
                // Braking before touchdown must belong to this same jump path.
                for (const release of Object.keys(ACTIONS)) {
                  if (release.includes('jump')) continue;
                  restoreSnapshot(boundary);
                  this.predictor.frame = boundaryFrame;
                  for (let rest = elapsed; rest < horizon; ) {
                    const duration = Math.min(frames, horizon - rest);
                    this.predictor.advance(release, duration);
                    rest += duration;
                    const candidate = readPlayer(this.predictor.ram);
                    if (candidate.dead || this.predictor.lastEvents.mazeReset)
                      break;
                    if (usableRunJumpLanding(candidate)) {
                      runJumpLanding = true;
                      break;
                    }
                    if (!candidate.controllable) break;
                  }
                  if (runJumpLanding) break;
                }
                restoreSnapshot(boundary);
                this.predictor.frame = boundaryFrame;
              }
              if (!landing.controllable) break;
            }
          }
          if (runJumpLanding || prefix === 3) break;
          restoreSnapshot(prefixSnapshot);
          this.predictor.frame =
            this.frame + frames + continuationFrames * prefix;
          this.predictor.advance(action, continuationFrames);
          const continued = readPlayer(this.predictor.ram);
          if (
            continued.dead ||
            !continued.controllable ||
            this.predictor.lastEvents.mazeReset
          )
            break;
          prefixSnapshot = structuredClone(this.predictor.nes.toJSON());
        }
      }
      let hiddenBlockReadyFrames;
      if (hiddenBlocks.length && !next.dead) {
        const probeRelease = (prefixSnapshot, prefixFrame, delay) => {
          for (const release of Object.keys(ACTIONS)) {
            if (release.includes('jump')) continue;
            restoreSnapshot(prefixSnapshot);
            this.predictor.frame = prefixFrame;
            for (
              let elapsed = delay;
              elapsed < 3 * continuationFrames;
              elapsed += frames
            ) {
              this.predictor.advance(release, frames);
              const candidate = readPlayer(this.predictor.ram);
              if (
                candidate.dead ||
                !candidate.controllable ||
                this.predictor.lastEvents.mazeReset ||
                candidate.areaDataAddress !== origin.areaDataAddress
              )
                break;
              const duration = this.predictor.frame - this.frame;
              if (
                duration >= (hiddenBlockReadyFrames ?? Number.POSITIVE_INFINITY)
              )
                break;
              // A bouncing tile is not yet a permanent supporting block.
              if (
                !readyForNextChoice(candidate, release) ||
                !hiddenBlocks.some(
                  ({ x, y }) =>
                    tileAt(this.predictor.ram, x, y, candidate.cameraX) ===
                    0xc4,
                )
              )
                continue;
              const boundary = structuredClone(this.predictor.nes.toJSON());
              const boundaryFrame = this.predictor.frame;
              const usable = readyBoundarySurvives(boundary, boundaryFrame);
              restoreSnapshot(boundary);
              this.predictor.frame = boundaryFrame;
              if (usable) {
                hiddenBlockReadyFrames = duration;
                break;
              }
            }
          }
        };
        probeRelease(nextSnapshot, nextFrame, 0);
        // A held A button may need this first non-jump action to rearm.
        const jumps = action.includes('jump')
          ? [action]
          : Object.keys(ACTIONS).filter((option) => option.includes('jump'));
        for (const jump of jumps) {
          restoreSnapshot(nextSnapshot);
          this.predictor.frame = nextFrame;
          for (
            let delay = frames;
            delay <= 2 * continuationFrames;
            delay += frames
          ) {
            this.predictor.advance(jump, frames);
            const continued = readPlayer(this.predictor.ram);
            if (
              continued.dead ||
              !continued.controllable ||
              this.predictor.lastEvents.mazeReset
            )
              break;
            const boundary = structuredClone(this.predictor.nes.toJSON());
            const boundaryFrame = this.predictor.frame;
            probeRelease(boundary, boundaryFrame, delay);
            restoreSnapshot(boundary);
            this.predictor.frame = boundaryFrame;
          }
        }
      }
      let supportLandingFrames;
      if (narrowSupports.length && !next.dead) {
        const sampleFrames = supportSamplingFrames;
        const verificationFrames = supportValidationFrames;
        const localCadenceMatches = (player) => {
          const context = narrowSupportContext(this.predictor.ram, player, 1);
          return (
            context.nearby &&
            Math.min(configuredFrames, context.frameCap) === sampleFrames
          );
        };
        const inSupportWindow = (player) =>
          player.controllable &&
          !player.dead &&
          player.world === origin.world &&
          player.stage === origin.stage &&
          player.areaDataAddress === origin.areaDataAddress &&
          localCadenceMatches(player) &&
          narrowSupports.some(
            (floor) => Math.abs(player.x - floor.startX) <= 64,
          );
        const onPermanentSupport = (player, floors = narrowSupports) =>
          floors.some(
            (floor) =>
              landsOn(player, [floor]) &&
              tileAt(
                this.predictor.ram,
                floor.startX,
                floor.topY,
                player.cameraX,
              ) === 0xc4,
          );
        const stableSupport = () => {
          const player = readPlayer(this.predictor.ram);
          if (!inSupportWindow(player) || !onPermanentSupport(player))
            return false;
          const target = narrowSupports.find((floor) =>
            onPermanentSupport(player, [floor]),
          );
          const bytes = serialize(this.predictor.nes.toJSON());
          const frame = this.predictor.frame;
          for (const release of Object.keys(ACTIONS)) {
            if (release.includes('jump')) continue;
            this.predictor.nes.fromJSON(deserialize(bytes));
            this.predictor.frame = frame;
            let stable = true;
            for (
              let elapsed = 0;
              elapsed < verificationFrames;
              elapsed += sampleFrames
            ) {
              this.predictor.advance(release, sampleFrames);
              const end = readPlayer(this.predictor.ram);
              if (
                !inSupportWindow(end) ||
                !end.jumpAvailable ||
                !onPermanentSupport(end, [target])
              ) {
                stable = false;
                break;
              }
            }
            if (stable) {
              supportLandingFrames = frame - this.frame + verificationFrames;
              break;
            }
          }
          this.predictor.nes.fromJSON(deserialize(bytes));
          this.predictor.frame = frame;
          return supportLandingFrames !== undefined;
        };
        restoreSnapshot(nextSnapshot);
        this.predictor.frame = nextFrame;
        let beam = inSupportWindow(next)
          ? [{ bytes: serialize(nextSnapshot), frame: nextFrame }]
          : [];
        if (stableSupport()) beam = [];
        // Every hypothesis retains a complete NES state. Pruning means unknown,
        // never a trap; this probe returns no sequence for live execution.
        supportSearch: for (
          let elapsed = 0;
          elapsed + sampleFrames <= supportPreparationFrames &&
          supportLandingFrames === undefined &&
          beam.length;
          elapsed += sampleFrames
        ) {
          const candidates = new Map();
          for (const node of beam) {
            for (const followup of Object.keys(ACTIONS)) {
              this.predictor.nes.fromJSON(deserialize(node.bytes));
              this.predictor.frame = node.frame;
              this.predictor.advance(followup, sampleFrames);
              const player = readPlayer(this.predictor.ram);
              if (
                !inSupportWindow(player) ||
                this.predictor.lastEvents.mazeReset
              )
                continue;
              if (stableSupport()) break supportSearch;
              const velocity = this.predictor.ram[0x57];
              const key = [
                Math.floor(player.x / 8),
                Math.floor(player.y / 8),
                player.jumpPhase,
                followup.includes('jump'),
                Math.sign(velocity < 128 ? velocity : velocity - 256),
              ].join(',');
              const score = Math.min(
                ...narrowSupports.map(
                  (floor) =>
                    Math.abs(player.x - floor.startX) +
                    Math.abs(player.y + player.height - floor.topY),
                ),
              );
              if (!candidates.has(key) || score < candidates.get(key).score)
                candidates.set(key, {
                  bytes: serialize(this.predictor.nes.toJSON()),
                  frame: this.predictor.frame,
                  score,
                });
            }
          }
          beam = [...candidates.values()]
            .toSorted((a, b) => a.score - b.score)
            .slice(0, 16);
        }
      }
      let pipeProgress = false;
      let pipeEntryFrames;
      if (probePipeEntry && !next.dead) {
        const resolvesAheadPipe = () => {
          const entry = readPlayer(this.predictor.ram);
          if (entry.dead || !entry.automatic || entry.state !== 3) return false;
          let automaticFrames = 0;
          while (
            readPlayer(this.predictor.ram).automatic &&
            automaticFrames < 6000
          )
            automaticFrames += this.predictor.advanceTransition();
          const destination = readPlayer(this.predictor.ram);
          if (destination.automatic)
            throw new Error(
              'Prepared pipe destination forecast exceeded 6000 automatic frames.',
            );
          return (
            destination.controllable &&
            !destination.dead &&
            destination.world === origin.world &&
            destination.stage === origin.stage &&
            (destination.areaDataAddress !== origin.areaDataAddress ||
              destination.x > origin.x)
          );
        };
        for (const followup of Object.keys(ACTIONS)) {
          restoreSnapshot(nextSnapshot);
          this.predictor.frame = nextFrame;
          for (
            let elapsed = 0;
            elapsed <= 3 * continuationFrames;
            elapsed += frames
          ) {
            const prepared = readPlayer(this.predictor.ram);
            if (prepared.dead) break;
            const boundary = structuredClone(this.predictor.nes.toJSON());
            const boundaryFrame = this.predictor.frame;
            if (
              boundaryFrame - this.frame >=
              (pipeEntryFrames ?? Number.POSITIVE_INFINITY)
            )
              break;
            if (prepared.controllable) this.predictor.advance('down', horizon);
            const entryFrame = this.predictor.frame;
            if (resolvesAheadPipe()) {
              pipeProgress = true;
              pipeEntryFrames = Math.min(
                pipeEntryFrames ?? Number.POSITIVE_INFINITY,
                entryFrame - this.frame,
              );
            }
            restoreSnapshot(boundary);
            this.predictor.frame = boundaryFrame;
            if (!prepared.controllable || elapsed === 3 * continuationFrames)
              break;
            this.predictor.advance(followup, frames);
            if (this.predictor.lastEvents.mazeReset) break;
          }
        }
      }
      moves[action] = {
        ...(narrowSupports.length
          ? {
              supportLanding: supportLandingFrames !== undefined,
              ...(supportLandingFrames !== undefined
                ? { supportLandingFrames }
                : {}),
            }
          : {}),
        ...(hiddenBlocks.length
          ? {
              revealsHiddenBlock: hiddenBlockReadyFrames !== undefined,
              ...(hiddenBlockReadyFrames !== undefined
                ? { hiddenBlockReadyFrames }
                : {}),
            }
          : {}),
        ...(probePipeEntry
          ? { pipeProgress, ...(pipeProgress ? { pipeEntryFrames } : {}) }
          : {}),
        next: position(next),
        held: position(held),
        highestY,
        repeatsMaze,
        ...(mazeFloors.length
          ? {
              mazeLanding,
              mazeConnectedLanding,
              groundedMazeReset,
              mazeCheckpointFailedNext,
              mazeCheckpointFailedHeld,
              mazeCheckpointFeedbackNext: nextChecks,
              mazeCheckpointFeedbackHeld: [...nextChecks, ...heldChecks],
            }
          : {}),
        ...(climbFloors.length || higherLandingY !== undefined
          ? { climbLanding }
          : {}),
        ...(runJumpTargetX !== undefined ? { runJumpLanding } : {}),
        jumpReadyNext: next.jumpAvailable && !action.includes('jump'),
        survivesWithOneReplan,
        clearsLevel: next.levelClear || held.levelClear,
        entersArea,
        ...(areaDestination ? { areaDestination } : {}),
        ...(returnsWithinArea ? { returnsWithinArea } : {}),
        ...(headBump ? { headBump: true } : {}),
        ...(noSurvivingFollowup ? { noSurvivingFollowup: true } : {}),
      };
    }
    return {
      frames,
      heldFor: horizon,
      continuationFrames,
      trapLookaheadFrames: frames * 3,
      readyStateLookaheadFrames: frames + 3 * continuationFrames,
      readyStateSurvivalLookaheadFrames: frames + 5 * continuationFrames,
      ...(narrowSupports.length
        ? {
            narrowSupportSamplingFrames: Math.min(configuredFrames, 8),
            narrowSupportPreparationLookaheadFrames:
              frames + supportPreparationFrames,
            narrowSupportValidationFrames: supportValidationFrames,
            narrowSupportLookaheadFrames: frames + 5 * continuationFrames,
            narrowSupportBeamWidth: 16,
          }
        : {}),
      ...(runJumpTargetX !== undefined
        ? { runJumpLookaheadFrames: runJumpHorizon }
        : {}),
      ...(probePipeEntry
        ? {
            pipeEntryLookaheadFrames: frames + 3 * continuationFrames + horizon,
            pipeAutomaticFrameLimit: 6000,
          }
        : {}),
      moves,
    };
  }

  advance(action, frames) {
    if (!Object.hasOwn(ACTIONS, action))
      throw new Error(`Unknown action: ${action}`);
    if (!Number.isInteger(frames) || frames < 1 || frames > 60)
      throw new Error('Invalid frame count.');
    this.release();
    this.lastEvents = {
      headBump: false,
      landed: false,
      highestY: readPlayer(this.ram).y,
    };
    for (const button of ACTIONS[action]) this.nes.buttonDown(1, button);
    let advanced = 0;
    while (advanced < frames) {
      const before = readPlayer(this.ram);
      if (
        before.dead ||
        before.clear ||
        before.levelClear ||
        !before.controllable
      )
        break;
      const mazePass = this.ram[0x6da];
      const mazeCorrect = this.ram[0x6d9];
      const mazePage = this.ram[0x725];
      this.nes.frame();
      const after = readPlayer(this.ram);
      if (
        before.controllable &&
        after.controllable &&
        before.world === after.world &&
        before.stage === after.stage &&
        before.area === after.area &&
        after.x < before.x - 256
      )
        this.lastEvents.mazeReset = {
          x: before.x,
          feet: before.y + before.height,
          grounded: before.grounded,
        };
      if (
        before.world === 7 &&
        before.stage === 4 &&
        after.controllable &&
        before.world === after.world &&
        before.stage === after.stage &&
        before.area === after.area &&
        mazePass !== this.ram[0x6da]
      ) {
        const sequenceEnded = mazePass === 2 && this.ram[0x6da] === 0;
        const reset = after.x < before.x - 256;
        // An earlier failed check makes the final check's result ambiguous.
        const correct = sequenceEnded
          ? reset
            ? mazeCorrect === 2
              ? false
              : null
            : true
          : this.ram[0x6d9] > mazeCorrect;
        const stableFloor =
          before.grounded && after.grounded && before.y === after.y;
        this.lastEvents.mazeCheckpoints ??= [];
        this.lastEvents.mazeCheckpoints.push({
          page: mazePage,
          x: before.x,
          ordinal: mazePass + 1,
          correct,
          floorY: stableFloor ? before.y + before.height : null,
          sequenceEnded,
          sequenceCorrect: sequenceEnded ? !reset : null,
        });
      }
      this.lastEvents.highestY = Math.min(this.lastEvents.highestY, after.y);
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

  advanceTransition(frames = 60) {
    if (!Number.isInteger(frames) || frames < 1 || frames > 60)
      throw new Error('Invalid transition frame count.');
    this.release();
    this.lastEvents = { headBump: false, landed: false };
    let advanced = 0;
    while (advanced < frames && readPlayer(this.ram).automatic) {
      this.nes.frame();
      this.frame++;
      advanced++;
    }
    return advanced;
  }
}
