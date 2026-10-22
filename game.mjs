import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MarioEmulator } from './emulator.mjs';
import { Experience, experienceStep } from './experience.mjs';
import { integer, loopbackURL } from './http.mjs';
import { choose } from './policy.mjs';
import { Telemetry } from './telemetry.mjs';

export class Game {
  constructor({
    baseURL = 'http://127.0.0.1:8766',
    framesPerDecision = 16,
    maxDecisions = 3000,
    logDirectory,
    experienceDirectory = join(logDirectory, 'experience'),
    experienceEnabled = false,
    makeEmulator = () => new MarioEmulator(),
    decide = choose,
  }) {
    this.baseURL = loopbackURL(baseURL);
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
    this.makeEmulator = makeEmulator;
    this.decide = decide;
    this.status = 'missing_rom';
    this.error = null;
    this.busy = false;
    this.running = false;
    this.count = 0;
  }

  log(event) {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ time: new Date().toISOString(), runId: this.runId, ...event })}\n`,
    );
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
        experienceEnabled: this.experienceEnabled,
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
      status: this.status,
      error: this.error,
      busy: this.busy,
      running: this.running,
      decisions: this.count,
      maxDecisions: this.maxDecisions,
      runId: this.runId ?? null,
      logFile: this.runId ? `midscene_run/logs/${this.runId}.jsonl` : null,
      framesPerDecision: this.framesPerDecision,
      state: this.snapshot ?? null,
      decision: this.lastDecision ?? null,
      loaded: Boolean(this.emulator),
      learning: this.snapshot?.experience ?? null,
      experienceEnabled: this.experienceEnabled,
    };
  }

  assertPlayable() {
    if (!this.emulator)
      throw new Error('Missing ROM. Select your own local SMB1 .nes file.');
    if (this.snapshot.episode.terminal || this.count >= this.maxDecisions)
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
    try {
      before.experience = this.experience?.recall(before) ?? null;
      before.forecast = this.emulator.forecast(this.framesPerDecision);
      this.log({ kind: 'request', index: this.count, state: before });
      const decision = await this.decide(before, {
        baseURL: this.baseURL,
        runId: this.runId,
        signal,
      });
      signal.throwIfAborted();
      this.log({ kind: 'choice', index: this.count, decision });
      const frames = this.emulator.advance(
        decision.action,
        this.framesPerDecision,
      );
      if (!frames)
        throw new Error('Emulator did not advance a playable frame.');
      this.snapshot = this.telemetry.sample(
        this.emulator.ram,
        this.emulator.frame,
        decision.action,
        this.emulator.lastEvents,
      );
      this.trace.push(experienceStep(before, decision.action, this.snapshot));
      this.trace = this.trace.slice(-12);
      this.count++;
      this.lastDecision = decision;
      this.log({
        kind: 'transition',
        index: this.count - 1,
        action: decision.action,
        frames,
        state: this.snapshot,
      });
      this.status =
        this.snapshot.episode.terminal ??
        (this.count >= this.maxDecisions ? 'limit' : 'paused');
      if (['dead', 'clear', 'limit'].includes(this.status)) {
        this.running = false;
        this.saveExperience(this.status);
      }
      this.snapshot.experience = this.experience?.recall(this.snapshot) ?? null;
      return this.info();
    } catch (error) {
      this.running = false;
      this.status = signal.aborted ? 'paused' : 'error';
      this.error = signal.aborted ? null : error.message;
      try {
        this.log({
          kind: signal.aborted ? 'cancelled' : 'error',
          message: error.message,
        });
      } catch (logError) {
        this.status = 'error';
        this.error = `${error.message}; cannot persist error: ${logError.message}`;
      }
      if (!signal.aborted || this.status === 'error')
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

  async run() {
    try {
      while (this.running) {
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
