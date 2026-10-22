import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ACTIONS } from './policy.mjs';

const outcomes = ['dead', 'clear', 'limit', 'restarted'];

function failureReason(record) {
  if (record.outcome === 'dead') return 'death';
  if (
    record.trace.length >= 3 &&
    record.trace.slice(-3).every((step) => step.toX <= step.x)
  )
    return 'no_forward_progress';
  return null;
}

function validate(record, hash, frames) {
  if (
    record?.version !== 1 ||
    record.romSHA256 !== hash ||
    record.framesPerDecision !== frames ||
    !outcomes.includes(record.outcome) ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(record.runId) ||
    !['world', 'stage', 'endX', 'bestX'].every((key) =>
      Number.isFinite(record[key]),
    ) ||
    !Array.isArray(record.trace) ||
    record.trace.length < 1 ||
    record.trace.length > 12 ||
    !record.trace.every(
      (step) =>
        typeof step.action === 'string' &&
        Object.hasOwn(ACTIONS, step.action) &&
        ['x', 'y', 'toX', 'toY'].every((key) => Number.isFinite(step[key])) &&
        ['headBump', 'landed', 'heldJump'].every(
          (key) => typeof step[key] === 'boolean',
        ),
    )
  )
    throw new Error(
      'Invalid cross-episode memory. Inspect the experience file; it will not be silently ignored.',
    );
  return record;
}

export function experienceStep(before, action, after) {
  return {
    x: before.player.x,
    y: before.player.y,
    action,
    toX: after.player.x,
    toY: after.player.y,
    headBump: after.recent_control.headBump,
    landed: after.recent_control.landed,
    heldJump: after.recent_control.heldJump,
  };
}

export class Experience {
  constructor(directory, hash, frames) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error('Experience requires a ROM SHA-256.');
    this.hash = hash;
    this.frames = frames;
    this.directory = join(directory, hash, `frames-${frames}`);
    mkdirSync(this.directory, { recursive: true });
  }

  records() {
    return readdirSync(this.directory)
      .filter((name) => /^\d{13}-[a-zA-Z0-9-]+\.json$/.test(name))
      .sort()
      .slice(-64)
      .map((name) =>
        validate(
          JSON.parse(readFileSync(join(this.directory, name), 'utf8')),
          this.hash,
          this.frames,
        ),
      );
  }

  save({ runId, outcome, state, trace }) {
    const record = validate(
      {
        version: 1,
        romSHA256: this.hash,
        framesPerDecision: this.frames,
        runId,
        outcome,
        world: state.player.world,
        stage: state.player.stage,
        endX: state.player.x,
        bestX: state.episode.bestX,
        trace: trace.slice(-12),
      },
      this.hash,
      this.frames,
    );
    const path = join(this.directory, `${Date.now()}-${runId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
      renameSync(temporary, path);
    } catch (error) {
      // Only remove this writer's temporary file, never an existing episode.
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT')
          throw new Error(
            `${error.message}; memory cleanup failed: ${cleanupError.message}`,
            { cause: error },
          );
      }
      throw error;
    }
  }

  recall(state) {
    const records = this.records();
    const relevant = records.filter(
      (record) =>
        record.world === state.player.world &&
        record.stage === state.player.stage &&
        state.player.x >=
          Math.min(...record.trace.map((step) => step.x)) - 128 &&
        state.player.x <= record.bestX + 32,
    );
    const failures = relevant
      .filter((record) => failureReason(record) !== null)
      .slice(-2);
    const progress = relevant
      .filter(
        (record) =>
          failureReason(record) === null && record.bestX > state.player.x + 64,
      )
      .sort((a, b) => b.bestX - a.bestX)
      .slice(0, 1);
    return {
      type: 'local_episode_memory_not_weight_training',
      episodes: records.length,
      deaths: records.filter((record) => record.outcome === 'dead').length,
      bestX: records.length
        ? Math.max(...records.map((record) => record.bestX))
        : null,
      nearbyEpisodes: [...failures, ...progress].map((record) => ({
        runId: record.runId,
        outcome: record.outcome,
        failureReason: failureReason(record),
        endX: record.endX,
        trace: record.trace,
      })),
    };
  }
}
