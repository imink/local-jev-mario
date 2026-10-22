import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Game } from './game.mjs';
import { integer } from './http.mjs';
import { checkJev } from './policy.mjs';

if (!process.env.MARIO_ROM)
  throw new Error(
    'Set MARIO_ROM to your lawfully obtained local SMB1 .nes file. No ROM is bundled.',
  );
const baseURL = process.env.THIS_THAT_BASE_URL ?? 'http://127.0.0.1:8767';
const health = await checkJev(baseURL);
const count = integer(
  process.env.SMOKE_DECISIONS ?? 3,
  'SMOKE_DECISIONS',
  1,
  100,
);
const game = new Game({
  baseURL,
  framesPerDecision: process.env.FRAMES_PER_DECISION ?? 16,
  maxDecisions: count,
  logDirectory: fileURLToPath(new URL('./midscene_run/logs/', import.meta.url)),
  experienceDirectory: fileURLToPath(
    new URL('./midscene_run/experience/', import.meta.url),
  ),
});
game.load(await readFile(process.env.MARIO_ROM));
console.log(
  JSON.stringify({
    kind: 'live-smoke',
    model: health.model,
    runId: game.runId,
    startX: game.snapshot.player.x,
  }),
);
for (let i = 0; i < count; i++) {
  await game.step();
  console.log(
    JSON.stringify({
      decision: game.count,
      action: game.lastDecision.action,
      x: game.snapshot.player.x,
      y: game.snapshot.player.y,
      frame: game.snapshot.episode.frame,
      status: game.status,
      latencyMs: game.lastDecision.latencyMs,
    }),
  );
  if (game.snapshot.episode.terminal) break;
}
console.log(`Evidence: ${game.logPath}`);
