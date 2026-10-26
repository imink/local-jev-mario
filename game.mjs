import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MarioEmulator } from './emulator.mjs';
import { Experience, experienceStep } from './experience.mjs';
import { integer, loopbackURL } from './http.mjs';
import {
  DEFAULT_JEV_MODEL,
  OFFICIAL_JEV_URL,
  validateOfficialConfig,
} from './official-jev.mjs';
import { checkJev, choose } from './policy.mjs';
import { Telemetry } from './telemetry.mjs';

export class Game {
  #apiKey;

  constructor({
    baseURL,
    backend = 'this-that',
    apiKey,
    model = DEFAULT_JEV_MODEL,
    framesPerDecision = 16,
    maxDecisions = 20000,
    logDirectory,
    experienceDirectory = join(logDirectory, 'experience'),
    experienceEnabled = false,
    continuousPlay = true,
    makeEmulator = () => new MarioEmulator(),
    decide = choose,
  }) {
    if (!['this-that', 'jev-official'].includes(backend))
      throw new Error('Unknown decision backend.');
    this.backend = backend;
    this.model =
      backend === 'jev-official' ? model : 'flock-io/this-that-model-1.2';
    if (backend === 'jev-official') {
      if (baseURL !== undefined && baseURL !== OFFICIAL_JEV_URL)
        throw new Error('Official Jev only uses https://api.typesafe.ai.');
      validateOfficialConfig(apiKey, model);
      this.#apiKey = apiKey;
      this.baseURL = OFFICIAL_JEV_URL;
    } else {
      this.baseURL = loopbackURL(baseURL ?? 'http://127.0.0.1:8767');
    }
    this.framesPerDecision = integer(
      framesPerDecision,
      'FRAMES_PER_DECISION',
      1,
      60,
    );
    this.maxDecisions = integer(maxDecisions, 'MAX_DECISIONS', 1, 100000);
    this.logDirectory = logDirectory;
    this.experienceDirectory = experienceDirectory;
    if (typeof experienceEnabled !== 'boolean')
      throw new Error('experienceEnabled must be a boolean.');
    this.experienceEnabled = experienceEnabled;
    if (typeof continuousPlay !== 'boolean')
      throw new Error('continuousPlay must be a boolean.');
    this.continuousPlay = continuousPlay;
    this.makeEmulator = makeEmulator;
    this.decide = decide;
    this.status = 'missing_rom';
    this.error = null;
    this.busy = false;
    this.running = false;
    this.count = 0;
    this.transitionFrames = 0;
    this.pendingApplied = null;
  }

  log(event) {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ time: new Date().toISOString(), runId: this.runId, ...event })}\n`,
    );
  }

  checkHealth() {
    return checkJev(this.baseURL, {
      backend: this.backend,
      apiKey: this.#apiKey,
      model: this.model,
    });
  }

  load(bytes) {
    if (this.busy || this.running)
      throw new Error(
        'Pause and wait for inference to stop before loading or restarting.',
      );
    const emulator = this.makeEmulator();
    emulator.boot(bytes);
    const runId = randomUUID();
    mkdirSync(this.logDirectory, { recursive: true });
    const logPath = join(this.logDirectory, `${runId}.jsonl`);
    const telemetry = new Telemetry(this.framesPerDecision);
    const snapshot = telemetry.sample(emulator.ram, 0);
    const experience = this.experienceEnabled
      ? new Experience(
          this.experienceDirectory,
          emulator.hash,
          this.framesPerDecision,
        )
      : null;
    experience?.records();
    this.saveExperience('restarted');
    appendFileSync(
      logPath,
      `${JSON.stringify({
        kind: 'start',
        runId,
        time: new Date().toISOString(),
        romSHA256: emulator.hash,
        framesPerDecision: this.framesPerDecision,
        engine: 'JSNES 2.1.0',
        inference: this.baseURL,
        decisionBackend: this.backend,
        requestedModel: this.model,
        experienceEnabled: this.experienceEnabled,
        continuousPlay: this.continuousPlay,
      })}\n`,
      { flag: 'wx' },
    );
    this.emulator = emulator;
    this.rom = Buffer.from(bytes);
    this.runId = runId;
    this.logPath = logPath;
    this.telemetry = telemetry;
    this.snapshot = snapshot;
    this.experience = experience;
    this.trace = [];
    this.experienceSaved = false;
    this.snapshot.experience = experience?.recall(snapshot) ?? null;
    this.lastDecision = null;
    this.count = 0;
    this.transitionFrames = 0;
    this.pendingApplied = null;
    this.status = 'paused';
    this.error = null;
    return this.info();
  }

  restart() {
    if (!this.rom) throw new Error('Load a lawfully obtained local ROM first.');
    return this.load(this.rom);
  }

  saveExperience(outcome) {
    if (!this.experience || this.experienceSaved || !this.trace.length) return;
    this.experience.save({
      runId: this.runId,
      outcome,
      state: this.snapshot,
      trace: this.trace,
    });
    this.experienceSaved = true;
  }

  info() {
    return {
      decisionBackend: this.backend,
      requestedModel: this.model,
      status: this.status,
      error: this.error,
      busy: this.busy,
      running: this.running,
      decisions: this.count,
      pendingApplied: this.pendingApplied,
      maxDecisions: this.maxDecisions,
      runId: this.runId ?? null,
      logFile: this.runId ? `midscene_run/logs/${this.runId}.jsonl` : null,
      framesPerDecision:
        this.snapshot?.reaction_timing.framesPerDecision ??
        this.framesPerDecision,
      configuredFramesPerDecision: this.framesPerDecision,
      state: this.snapshot ?? null,
      decision: this.lastDecision ?? null,
      loaded: Boolean(this.emulator),
      learning: this.snapshot?.experience ?? null,
      experienceEnabled: this.experienceEnabled,
      continuousPlay: this.continuousPlay,
    };
  }

  assertPlayable() {
    if (!this.emulator)
      throw new Error('Missing ROM. Select your own local SMB1 .nes file.');
    const resumingDeath =
      this.continuousPlay &&
      this.snapshot.player.dead &&
      !this.snapshot.player.gameOver;
    if (
      (this.snapshot.episode.terminal && !resumingDeath) ||
      this.count >= this.maxDecisions
    )
      throw new Error('Episode ended. Restart explicitly to play again.');
    if (this.status === 'error')
      throw new Error(
        'The run failed. Restart explicitly after fixing the reported error.',
      );
  }

  async step() {
    this.assertPlayable();
    if (this.busy) throw new Error('A decision is already in flight.');
    this.busy = true;
    this.status = 'thinking';
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const before = this.snapshot;
    let actionApplied = false;
    try {
      if (before.player.automatic) {
        if (this.transitionFrames >= 6000)
          throw new Error(
            'Automatic level/area transition exceeded 6000 frames; stopped without skipping RAM timers.',
          );
        const frames = this.emulator.advanceTransition(60);
        if (!frames) throw new Error('Automatic transition did not advance.');
        actionApplied = true;
        this.transitionFrames += frames;
        this.pendingApplied = {
          kind: 'automatic-applied',
          action: 'noop',
          frames,
          beforeFrame: before.episode.frame,
          frame: this.emulator.frame,
          ram: Array.from(this.emulator.ram.slice(0, 0x800)),
        };
        this.log(this.pendingApplied);
        this.snapshot = this.telemetry.sample(
          this.emulator.ram,
          this.emulator.frame,
          'noop',
          this.emulator.lastEvents,
        );
        this.log({
          kind: 'automatic-transition',
          reason: before.player.dead ? 'death-and-respawn' : 'level-or-area',
          action: 'noop',
          frames,
          state: this.snapshot,
        });
        this.pendingApplied = null;
        if (
          this.snapshot.campaign.areaChanged ||
          this.snapshot.player.lives !== before.player.lives
        )
          this.trace = [];
        this.updateStatus();
        return this.info();
      }
      if (!before.player.controllable)
        throw new Error(
          'Unexpected non-playable game state; no controller action was selected.',
        );
      this.transitionFrames = 0;
      const decisionFrames = before.reaction_timing.framesPerDecision;
      before.experience = this.experience?.recall(before) ?? null;
      before.forecast = this.emulator.forecast(decisionFrames, {
        mazeFloors: before.navigation.mazeRoute?.alternativeFloors ?? [],
        mazeSteppingFloors: before.navigation.mazeRoute
          ? before.terrain.surfaces
              .filter(
                (floor) =>
                  before.navigation.mazeRoute.failedFloorYs.includes(
                    floor.topY,
                  ) &&
                  before.navigation.mazeRoute.alternativeFloorYs.some(
                    (height) => floor.topY < height,
                  ) &&
                  floor.startX < before.navigation.mazeRoute.gateX - 64,
              )
              .map(({ topY, startX, endX }) => ({
                topY,
                startX,
                endX: Math.min(endX, before.navigation.mazeRoute.gateX - 64),
              }))
          : [],
        climbFloors: before.navigation.climbFloors ?? [],
        higherLandingY: before.navigation.higherLandingY,
        runJumpTargetX: before.navigation.runJumpTargetX,
        probePipeEntry:
          Boolean(before.navigation.observedLoopCount) &&
          before.terrain.pipeTops.length > 0,
        hiddenBlocks:
          before.navigation.observedLoopCount && before.terrain.pipeTops.length
            ? before.terrain.hiddenBlocks
            : [],
        narrowSupports: before.navigation.narrowSupports ?? [],
        configuredFrames: this.framesPerDecision,
      });
      this.log({ kind: 'request', index: this.count, state: before });
      const decision = await this.decide(before, {
        baseURL: this.baseURL,
        backend: this.backend,
        apiKey: this.#apiKey,
        model: this.model,
        runId: this.runId,
        signal,
      });
      signal.throwIfAborted();
      this.log({ kind: 'choice', index: this.count, decision });
      const frames = this.emulator.advance(decision.action, decisionFrames);
      if (!frames)
        throw new Error('Emulator did not advance a playable frame.');
      actionApplied = true;
      this.count++;
      this.lastDecision = decision;
      this.pendingApplied = {
        kind: 'applied',
        index: this.count - 1,
        action: decision.action,
        frames,
        beforeFrame: before.episode.frame,
        frame: this.emulator.frame,
        ram: Array.from(this.emulator.ram.slice(0, 0x800)),
      };
      this.log(this.pendingApplied);
      this.snapshot = this.telemetry.sample(
        this.emulator.ram,
        this.emulator.frame,
        decision.action,
        this.emulator.lastEvents,
      );
      if (this.snapshot.campaign.areaChanged) this.trace = [];
      else
        this.trace.push(experienceStep(before, decision.action, this.snapshot));
      this.trace = this.trace.slice(-12);
      this.log({
        kind: 'transition',
        index: this.count - 1,
        action: decision.action,
        frames,
        state: this.snapshot,
      });
      this.pendingApplied = null;
      this.updateStatus();
      this.snapshot.experience = this.experience?.recall(this.snapshot) ?? null;
      return this.info();
    } catch (error) {
      const cancelled = signal.aborted && !this.pendingApplied;
      this.running = false;
      this.status = cancelled ? 'paused' : 'error';
      this.error = cancelled ? null : error.message;
      if (this.pendingApplied) {
        this.status = 'error';
        this.error = `${error.message}; action already applied at frame ${this.pendingApplied.frame}, transition incomplete.`;
      }
      try {
        this.log({
          kind: cancelled ? 'cancelled' : 'error',
          message: this.error ?? error.message,
          phase: actionApplied ? 'post-action' : 'pre-action',
        });
      } catch (logError) {
        this.status = 'error';
        this.error = `${error.message}; cannot persist error: ${logError.message}`;
      }

      if (!cancelled || this.status === 'error')
        throw new Error(this.error, { cause: error });
      return this.info();
    } finally {
      this.busy = false;
      this.emulator.release();
    }
  }

  start() {
    this.assertPlayable();
    if (this.busy || this.running) throw new Error('Agent is already running.');
    this.running = true;
    this.loop = this.run();
    return this.info();
  }

  updateStatus() {
    if (this.snapshot.episode.terminal === 'incomplete')
      throw new Error(
        `Reached 8-4 but completed only ${this.snapshot.campaign.completedLevels.length}/32 levels. Skipped levels do not count as a full campaign clear.`,
      );
    const terminal = this.snapshot.episode.terminal;
    this.status =
      terminal === 'clear'
        ? 'clear'
        : this.count >= this.maxDecisions
          ? 'limit'
          : terminal === 'dead' && this.continuousPlay
            ? this.snapshot.player.gameOver
              ? 'game_over'
              : 'respawning'
            : (terminal ??
              (this.snapshot.player.automatic ? 'transitioning' : 'paused'));
    if (['dead', 'clear', 'limit'].includes(this.status)) {
      this.running = false;
      this.saveExperience(this.status);
    }
  }

  async run() {
    try {
      while (this.running) {
        if (this.continuousPlay && this.snapshot.player.gameOver) {
          this.log({
            kind: 'automatic-restart',
            reason: 'game-over',
            completedLevels: this.snapshot.campaign.completedLevels,
          });
          this.saveExperience('dead');
          this.running = false;
          this.restart();
          this.running = true;
        }
        await this.step();
        // Yield to pause/status requests even when a mock or cached policy resolves immediately.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      this.running = false;
      this.status = 'error';
      this.error = error.message;
      console.error(`Mario agent stopped: ${error.message}`);
    }
  }

  pause() {
    this.running = false;
    this.controller?.abort(
      new Error('Paused by user; pending choice discarded.'),
    );
    if (!this.busy && this.status === 'thinking') this.status = 'paused';
    return this.info();
  }
}
