import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { deserialize, serialize } from 'node:v8';
import { crc32, deflateSync } from 'node:zlib';
import { MarioEmulator } from './emulator.mjs';
import { integer } from './http.mjs';
import { ACTIONS } from './policy.mjs';
import { readPlayer } from './telemetry.mjs';

const levels = Array.from(
  { length: 32 },
  (_, i) => `${Math.floor(i / 4) + 1}-${(i % 4) + 1}`,
);
const maximumLine = 2 * 1024 * 1024;

function png(pixels) {
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256);
  header.writeUInt32BE(240, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(240 * 1025);
  for (let y = 0; y < 240; y++)
    pixels.copy(rows, y * 1025 + 1, y * 1024, (y + 1) * 1024);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Byte offsets, not the entire decision log, stay resident.
export class RecordedReplay {
  constructor({
    rom,
    logPath,
    runId,
    makeEmulator = () => new MarioEmulator(),
  }) {
    this.rom = Buffer.from(rom);
    this.logPath = logPath;
    this.runId = runId;
    this.makeEmulator = makeEmulator;
    this.events = [];
    this.decisions = [];
    this.checkpoints = new Map();
    this.reconstructions = [];
  }

  async open() {
    this.file = await open(this.logPath, 'r');
    try {
      this.stat = await this.file.stat();
      if (
        !this.stat.isFile() ||
        !this.stat.size ||
        this.stat.size > 512 * 1024 * 1024
      )
        throw new Error(
          'Replay requires a regular, nonempty log under 512 MiB.',
        );
      let pending = Buffer.alloc(0);
      let offset = 0;
      let lastFrame = 0;
      let request;
      let choice;
      const hash = createHash('sha256');
      for await (const bytes of this.file.createReadStream({
        autoClose: false,
        start: 0,
        end: this.stat.size - 1,
      })) {
        hash.update(bytes);
        pending = Buffer.concat([pending, bytes]);
        let end = pending.indexOf(10);
        while (end !== -1) {
          if (end > maximumLine)
            throw new Error('Replay log line is too large.');
          const pointer = { offset, length: end };
          const event = JSON.parse(pending.subarray(0, end).toString('utf8'));
          assert.equal(event.runId, this.runId, 'Replay run identity differs.');
          if (!this.start) {
            assert.equal(event.kind, 'start', 'Replay must begin with start.');
            this.start = event;
          } else if (event.kind === 'request') {
            request = { ...pointer, index: event.index };
            this.initialState ??= event.state;
          } else if (event.kind === 'choice') {
            assert.equal(
              request?.index,
              event.index,
              'Missing historical input.',
            );
            choice = {
              ...pointer,
              index: event.index,
              request,
              action: event.decision.action,
            };
            assert.equal(
              choice.action,
              event.decision.raw.answers.move.choice,
              'Recorded action differs from raw Choice.',
            );
          } else if (
            ['transition', 'automatic-transition'].includes(event.kind)
          ) {
            const automatic = event.kind === 'automatic-transition';
            if (!automatic) {
              assert.equal(event.index, this.decisions.length);
              assert.equal(
                choice?.index,
                event.index,
                'Missing recorded Choice.',
              );
              assert.equal(event.action, choice.action);
              this.decisions.push(choice);
              choice = null;
            } else {
              assert.equal(event.action, 'noop');
            }
            if (!Object.hasOwn(ACTIONS, event.action))
              throw new Error('Unknown recorded action.');
            integer(event.frames, 'Recorded frames', 1, 60);
            assert.equal(event.state.episode.frame, lastFrame + event.frames);
            assert.deepEqual(
              event.state.campaign.completedLevels,
              levels.slice(0, event.state.campaign.completedLevels.length),
              'Historical clears are not in order.',
            );
            lastFrame += event.frames;
            this.events.push({
              ...pointer,
              automatic,
              action: event.action,
              frames: event.frames,
              owner: this.decisions.length - 1,
            });
            if (event.recovery)
              this.reconstructions.push({
                index: event.index,
                ...event.recovery,
              });
            if (this.events.length > 100000)
              throw new Error('Replay event limit exceeded.');
          }
          offset += end + 1;
          pending = pending.subarray(end + 1);
          end = pending.indexOf(10);
        }
        if (pending.length > maximumLine)
          throw new Error('Replay log line is too large.');
      }
      if (pending.length)
        throw new Error('Replay log ends with an incomplete record.');
      if (!this.decisions.length || !this.initialState)
        throw new Error(
          'No executed decisions with historical input to replay.',
        );
      this.logSHA256 = hash.digest('hex');
      this.totalFrames = lastFrame;
      this.reset();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    await this.file?.close();
    this.file = null;
    this.checkpoints.clear();
  }

  reset() {
    this.emulator = this.makeEmulator();
    this.emulator.boot(this.rom);
    assert.equal(
      this.emulator.hash,
      this.start.romSHA256,
      'Replay ROM hash differs.',
    );
    assert.equal(this.initialState.episode.frame, 0);
    this.cursor = 0;
    this.within = 0;
    this.count = 0;
    this.shownIndex = 0;
    this.phase = 'before';
    this.state = this.initialState;
    this.error = null;
    this.cachedEvent = null;
    this.cachedDecision = null;
  }

  async assertUnchanged() {
    const current = await this.file.stat();
    if (
      current.size !== this.stat.size ||
      current.mtimeMs !== this.stat.mtimeMs
    )
      throw new Error('The source log changed. Close and reopen replay.');
  }

  async read(pointer) {
    const buffer = Buffer.alloc(pointer.length);
    const { bytesRead } = await this.file.read(
      buffer,
      0,
      buffer.length,
      pointer.offset,
    );
    assert.equal(bytesRead, buffer.length, 'Historical record was truncated.');
    return JSON.parse(buffer.toString('utf8'));
  }

  async advance(frames = 60) {
    if (this.error) throw new Error(this.error);
    if (this.cursor === this.events.length) return 0;
    try {
      const entry = this.events[this.cursor];
      const amount = Math.min(
        integer(frames, 'Replay frames', 1, 60),
        entry.frames - this.within,
      );
      this.shownIndex = entry.owner;
      this.phase = entry.automatic ? 'automatic' : 'action';
      const advanced = entry.automatic
        ? this.emulator.advanceTransition(amount)
        : this.emulator.advance(entry.action, amount);
      assert.equal(
        advanced,
        amount,
        'Replay stopped before the recorded boundary.',
      );
      this.within += advanced;
      if (this.within === entry.frames) {
        const event = await this.read(entry);
        const player = readPlayer(this.emulator.ram);
        for (const [key, expected] of Object.entries(event.state.player)) {
          // Old logs predate this derived flag; the physical fields remain checked.
          if (key !== 'automatic')
            assert.deepEqual(
              player[key],
              expected,
              `Replay player.${key}, event ${this.cursor}`,
            );
        }
        assert.equal(this.emulator.frame, event.state.episode.frame);
        this.state = event.state;
        this.cachedEvent = event;
        this.emulator.release();
        this.within = 0;
        this.cursor++;
        if (!entry.automatic) this.count++;
        if (this.count % 250 === 0 && !this.events[this.cursor]?.automatic) {
          this.checkpoints.set(this.count, {
            nes: serialize(this.emulator.nes.toJSON()),
            pixels: Buffer.from(this.emulator.pixels),
            frame: this.emulator.frame,
            cursor: this.cursor,
            state: this.state,
            event,
          });
          if (this.checkpoints.size > 12)
            this.checkpoints.delete(this.checkpoints.keys().next().value);
        }
      }
      if (this.cursor === this.events.length) this.phase = 'complete';
      return advanced;
    } catch (error) {
      this.error = `Replay integrity failure: ${error.message}`;
      throw new Error(this.error, { cause: error });
    }
  }

  async step() {
    if (this.cursor === this.events.length) return;
    await this.advance();
    while (this.within || this.events[this.cursor]?.automatic)
      await this.advance();
  }

  async seek(target) {
    integer(target, 'Executed decision position', 0, this.decisions.length);
    this.reset();
    const available = [...this.checkpoints.keys()].filter(
      (count) => count <= target,
    );
    if (available.length) {
      this.count = Math.max(...available);
      const saved = this.checkpoints.get(this.count);
      this.emulator.nes.fromJSON(deserialize(saved.nes));
      saved.pixels.copy(this.emulator.pixels);
      this.emulator.frame = saved.frame;
      this.cursor = saved.cursor;
      this.state = saved.state;
      this.cachedEvent = saved.event;
      this.shownIndex = this.count - 1;
      this.phase = 'after';
    }
    while (this.count < target || this.events[this.cursor]?.automatic) {
      await this.step();
      if (this.count % 32 === 0) await setImmediate();
    }
    if (this.cursor === this.events.length) this.phase = 'complete';
  }

  async history() {
    if (this.cachedDecision?.index === this.shownIndex)
      return this.cachedDecision;
    const pointer = this.decisions[this.shownIndex];
    const [{ decision }, request] = await Promise.all([
      this.read(pointer),
      this.read(pointer.request),
    ]);
    this.cachedDecision = {
      index: this.shownIndex,
      time: request.time ?? null,
      inputFrame: request.state.episode.frame,
      requestState: request.state,
      decision,
    };
    return this.cachedDecision;
  }

  async packet(knownDecision) {
    const history = await this.history();
    return {
      runId: this.runId,
      count: this.count,
      total: this.decisions.length,
      frame: this.emulator.frame,
      totalFrames: this.totalFrames,
      phase: this.phase,
      decisionIndex: this.shownIndex,
      inputFrame: history.inputFrame,
      reconstructions: this.reconstructions,
      recovery: this.cachedEvent?.recovery ?? null,
      logSHA256: this.logSHA256,
      pixelSHA256: createHash('sha256')
        .update(this.emulator.pixels)
        .digest('hex'),
      image: png(this.emulator.pixels).toString('base64'),
      state: {
        player: readPlayer(this.emulator.ram),
        episode: { ...this.state.episode, frame: this.emulator.frame },
        campaign: this.state.campaign,
      },
      history: knownDecision === this.shownIndex ? undefined : history,
    };
  }
}
