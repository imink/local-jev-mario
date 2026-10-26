import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Game } from './game.mjs';
import { body, checkLocalRequest, integer, json, listen } from './http.mjs';
import { decisionConfig } from './official-jev.mjs';
import { RecordedReplay } from './replay.mjs';

const root = new URL('./', import.meta.url);
const assets = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['public/app.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
};

export function createGameServer(game) {
  let replay;
  let replayToken;
  let replayBusy = false;
  const requireLive = () => {
    if (replay || replayBusy)
      throw new Error(
        'Exit historical replay before using live controls or health checks.',
      );
  };
  const server = createServer(async (request, response) => {
    try {
      checkLocalRequest(request);
    } catch (error) {
      json(response, 403, { error: error.message });
      return;
    }
    try {
      if (request.method === 'GET' && assets[request.url]) {
        const [file, type] = assets[request.url];
        const content = await readFile(new URL(file, root));
        response.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        });
        response.end(content);
      } else if (request.method === 'GET' && request.url === '/api/status') {
        json(response, 200, {
          ...game.info(),
          replayActive: Boolean(replay || replayBusy),
        });
      } else if (request.method === 'GET' && request.url === '/api/health') {
        requireLive();
        json(response, 200, await game.checkHealth());
      } else if (request.method === 'GET' && request.url === '/api/frame') {
        if (!game.emulator) throw new Error('No ROM is loaded.');
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        response.end(game.emulator.pixels);
      } else if (request.method === 'POST' && request.url === '/api/rom') {
        requireLive();
        if (request.headers['content-type'] !== 'application/octet-stream')
          throw new Error('ROM upload requires application/octet-stream.');
        json(response, 200, game.load(await body(request, 40976)));
      } else if (request.method === 'POST' && request.url === '/api/control') {
        requireLive();
        if (request.headers['content-type'] !== 'application/json')
          throw new Error('Control requires application/json.');
        const { command } = JSON.parse((await body(request, 1024)).toString());
        if (!['start', 'pause', 'step', 'restart'].includes(command))
          throw new Error('Unknown control command.');
        if (command === 'step' && game.running)
          throw new Error('Pause continuous play before stepping.');
        const result = await game[command]();
        json(response, 200, result);
      } else if (request.method === 'POST' && request.url === '/api/replay') {
        if (request.headers['content-type'] !== 'application/json')
          throw new Error('Replay control requires application/json.');
        const input = JSON.parse((await body(request, 1024)).toString());
        const { command, token, position, frames, knownDecision } = input;
        if (
          !['open', 'close', 'tick', 'step', 'seek', 'status'].includes(
            command,
          ) ||
          Object.keys(input).some(
            (key) =>
              ![
                'command',
                'token',
                'position',
                'frames',
                'knownDecision',
              ].includes(key),
          )
        )
          throw new Error('Invalid replay command.');
        if (replayBusy)
          throw new Error('Replay operation already in progress.');
        if (command !== 'open' && (!replay || token !== replayToken))
          throw new Error('Replay session expired. Open replay again.');
        replayBusy = true;
        try {
          if (command === 'open') {
            if (!game.rom || !game.logPath || !game.count)
              throw new Error('No recorded game is available.');
            if (game.running || game.busy || game.pendingApplied)
              throw new Error(
                'Pause the live game and finish pending work before replay.',
              );
            await replay?.close();
            replay = null;
            const candidate = new RecordedReplay({
              rom: game.rom,
              logPath: game.logPath,
              runId: game.runId,
            });
            replay = await candidate.open();
            replayToken = randomUUID();
          } else if (command === 'close') {
            await replay.close();
            replay = null;
            replayToken = null;
            json(response, 200, { closed: true });
            return;
          } else {
            await replay.assertUnchanged();
            if (command === 'tick') {
              if (!Number.isInteger(frames))
                throw new Error('Replay frames must be an integer.');
              await replay.advance(frames);
            } else if (command === 'step') await replay.step();
            else if (command === 'seek') {
              if (!Number.isInteger(position))
                throw new Error('Replay position must be an integer.');
              await replay.seek(position);
            }
          }
          json(response, 200, {
            token: replayToken,
            ...(await replay.packet(knownDecision)),
          });
        } finally {
          replayBusy = false;
        }
      } else {
        json(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      console.error(`Mario HTTP error: ${error.message}`);
      if (!response.destroyed) json(response, 400, { error: error.message });
    }
  });
  server.on('close', () => {
    replay
      ?.close()
      .catch((error) => console.error(`Replay close failed: ${error.message}`));
  });
  return server;
}

export async function restoreTerminalGame(game, runId, rom) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId))
    throw new Error('RESTORE_TERMINAL_RUN must be a run UUID, not a path.');
  const logPath = join(game.logDirectory, `${runId}.jsonl`);
  const replay = new RecordedReplay({ rom, logPath, runId });
  try {
    await replay.open();
    await replay.seek(replay.decisions.length);
    const { player, campaign } = replay.state;
    if (
      !(
        player.gameOver ||
        (player.clear && campaign.completedLevels.length === 32)
      )
    )
      throw new Error(
        'Only a finished game can be restored without starting an Agent.',
      );
    if (game.backend !== replay.start.decisionBackend)
      throw new Error('Restoration backend differs from the recorded backend.');
    if (game.experienceEnabled || replay.start.experienceEnabled)
      throw new Error(
        'Terminal restoration requires cross-run experience disabled.',
      );
    game.emulator = replay.emulator;
    game.rom = Buffer.from(rom);
    game.runId = runId;
    game.logPath = logPath;
    game.snapshot = { ...replay.state, experience: null };
    game.lastDecision = (await replay.history()).decision;
    game.count = replay.count;
    game.framesPerDecision = replay.start.framesPerDecision;
    game.status = player.clear ? 'clear' : 'game_over';
    return game.info();
  } finally {
    await replay.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const game = new Game({
    ...decisionConfig(),
    framesPerDecision: process.env.FRAMES_PER_DECISION ?? 16,
    maxDecisions: process.env.MAX_DECISIONS ?? 20000,
    continuousPlay:
      integer(process.env.CONTINUOUS_PLAY ?? 1, 'CONTINUOUS_PLAY', 0, 1) === 1,
    experienceEnabled:
      integer(process.env.USE_EXPERIENCE ?? 0, 'USE_EXPERIENCE', 0, 1) === 1,
    logDirectory: fileURLToPath(new URL('midscene_run/logs/', root)),
    experienceDirectory: fileURLToPath(
      new URL('midscene_run/experience/', root),
    ),
  });
  if (process.env.MARIO_ROM) {
    try {
      const rom = await readFile(process.env.MARIO_ROM);
      if (process.env.RESTORE_TERMINAL_RUN)
        await restoreTerminalGame(game, process.env.RESTORE_TERMINAL_RUN, rom);
      else game.load(rom);
    } catch (error) {
      throw new Error(`Cannot load MARIO_ROM: ${error.message}`, {
        cause: error,
      });
    }
  } else if (process.env.RESTORE_TERMINAL_RUN)
    throw new Error('MARIO_ROM is required to restore a recorded terminal.');
  const port = integer(process.env.GAME_PORT ?? 4175, 'GAME_PORT', 1, 65535);
  const server = createGameServer(game);
  await listen(server, port);
  console.log(`Mario (${game.backend}): http://127.0.0.1:${port}`);
  console.log(
    game.emulator
      ? 'ROM loaded; agent paused.'
      : 'ROM missing: open the page and select your own legal SMB1 ROM.',
  );
  const shutdown = () => {
    game.pause();
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
