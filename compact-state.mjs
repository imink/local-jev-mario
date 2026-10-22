import assert from 'node:assert/strict';

const rectangle = (surface) => [
  surface.startX,
  surface.topY,
  surface.endX,
  surface.bottomY,
];
const interval = (gap) => [gap.startX, gap.endX];

function compressTrace(trace) {
  const result = [];
  for (const step of trace) {
    const last = result.at(-1);
    const flat = step.y === step.toY;
    if (
      last &&
      flat &&
      last.from[1] === last.to[1] &&
      last.action === step.action &&
      last.to[0] === step.x &&
      last.to[1] === step.y &&
      !last.headBump &&
      !last.landed &&
      !step.headBump &&
      !step.landed
    ) {
      last.to = [step.toX, step.toY];
      last.count++;
    } else {
      result.push({
        action: step.action,
        from: [step.x, step.y],
        to: [step.toX, step.toY],
        count: 1,
        ...(step.headBump ? { headBump: true } : {}),
        ...(step.landed ? { landed: true } : {}),
      });
    }
  }
  return result;
}

function distance(step, x) {
  return Math.max(
    0,
    Math.min(step.from[0], step.to[0]) - x,
    x - Math.max(step.from[0], step.to[0]),
  );
}

function memoryExcerpt(episode, x) {
  const trace = compressTrace(episode.trace);
  const closest = trace.reduce((best, step, index) => {
    const candidate = distance(step, x);
    const current = distance(trace[best], x);
    return candidate < current ||
      (candidate === current &&
        Math.abs(step.from[0] - x) < Math.abs(trace[best].from[0] - x))
      ? index
      : best;
  }, 0);
  const start = Math.max(0, closest - 1);
  const excerpt = trace.slice(start, start + 4);
  return {
    outcome: episode.outcome,
    reason: episode.failureReason,
    episodeEndX: episode.endX,
    endingStep: compressTrace(episode.trace.slice(-1))[0],
    omittedSteps:
      episode.trace.length - excerpt.reduce((sum, step) => sum + step.count, 0),
    steps: excerpt,
  };
}

export function compactState(state) {
  assert(
    state?.player &&
      state.trajectory &&
      state.terrain &&
      state.hazard &&
      state.reaction_timing &&
      state.recent_control &&
      state.episode,
    'Expected complete Mario telemetry for model input.',
  );
  const { player, terrain, recent_control: control } = state;
  const solids = terrain.surfaces.map(rectangle);
  const preview = terrain.lastGroundedPreview;
  const episodes = state.experience?.nearbyEpisodes ?? [];
  const failure = episodes
    .filter((episode) => episode.failureReason)
    .reverse()
    .toSorted(
      (a, b) => Math.abs(a.endX - player.x) - Math.abs(b.endX - player.x),
    )[0];
  const progress = episodes.find((episode) => !episode.failureReason);
  return {
    frames: state.reaction_timing.framesPerDecision,
    player: {
      x: player.x,
      y: player.y,
      height: player.height,
      vx: state.trajectory.velocityX,
      vy: player.verticalSpeed,
      phase: player.jumpPhase,
      canJump: control.jumpReady,
    },
    control: {
      last: control.action,
      heldA: control.heldJump,
      headBump: control.headBump,
      landed: control.landed,
      stalledFrames: state.episode.stalledFrames,
    },
    terrain: {
      observedX: terrain.observedX,
      solids,
      gaps: terrain.possibleGaps.map(interval),
      obstacle: terrain.obstacleAhead
        ? {
            distance: terrain.obstacleAhead.distancePixels,
            topY: terrain.obstacleAhead.topY,
          }
        : null,
      ...(preview
        ? {
            groundedPreview: {
              ageFrames: state.episode.frame - preview.frame,
              observedX: preview.observedX,
              extraSolids: preview.surfaces
                .map(rectangle)
                .filter(
                  (rect) =>
                    !solids.some((current) =>
                      current.every((value, i) => value === rect[i]),
                    ),
                ),
              gaps: preview.possibleGaps.map(interval),
            },
          }
        : {}),
    },
    hazard: {
      imminentCollision: state.hazard.imminentCollision,
      enemies: state.hazard.enemies.map((enemy) => ({
        type: enemy.name,
        dx: enemy.dx,
        dy: enemy.dy,
        projectedDx: enemy.projectedDx,
        contactInFrames: enemy.contactInFrames,
      })),
    },
    memory: [failure, progress]
      .filter(Boolean)
      .map((episode) => memoryExcerpt(episode, player.x)),
  };
}
