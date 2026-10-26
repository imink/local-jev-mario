import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Game } from './game.mjs';
import { integer } from './http.mjs';
import { decisionConfig } from './official-jev.mjs';
import { checkJev } from './policy.mjs';

if (!process.env.MARIO_ROM)
  throw new Error(
    'Set MARIO_ROM to your lawfully obtained local SMB1 .nes file. No ROM is bundled.',
  );
const config = decisionConfig();
const health = await checkJev(config.baseURL, config);
const count = integer(
  process.env.SMOKE_DECISIONS ?? 3,
  'SMOKE_DECISIONS',
  1,
  100,
);
const game = new Game({
  ...config,
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
while (game.count < count) {
  const automatic = game.snapshot.player.automatic;
  await game.step();
  console.log(
    JSON.stringify({
      decision: game.count,
      automatic,
      action: automatic ? 'noop' : game.lastDecision.action,
      campaign: game.snapshot.campaign,
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
