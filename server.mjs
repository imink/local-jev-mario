import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Game } from './game.mjs';
import { body, checkLocalRequest, integer, json, listen } from './http.mjs';
import { checkJev } from './policy.mjs';

const root = new URL('./', import.meta.url);
const assets = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['public/app.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
};

export function createGameServer(game) {
  return createServer(async (request, response) => {
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
        json(response, 200, game.info());
      } else if (request.method === 'GET' && request.url === '/api/health') {
        json(response, 200, await checkJev(game.baseURL));
      } else if (request.method === 'GET' && request.url === '/api/frame') {
        if (!game.emulator) throw new Error('No ROM is loaded.');
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        response.end(game.emulator.pixels);
      } else if (request.method === 'POST' && request.url === '/api/rom') {
        if (request.headers['content-type'] !== 'application/octet-stream')
          throw new Error('ROM upload requires application/octet-stream.');
        json(response, 200, game.load(await body(request, 40976)));
      } else if (request.method === 'POST' && request.url === '/api/control') {
        if (request.headers['content-type'] !== 'application/json')
          throw new Error('Control requires application/json.');
        const { command } = JSON.parse((await body(request, 1024)).toString());
        if (!['start', 'pause', 'step', 'restart'].includes(command))
          throw new Error('Unknown control command.');
        if (command === 'step' && game.running)
          throw new Error('Pause continuous play before stepping.');
        const result = await game[command]();
        json(response, 200, result);
      } else {
        json(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      console.error(`Mario HTTP error: ${error.message}`);
      if (!response.destroyed) json(response, 400, { error: error.message });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const game = new Game({
    baseURL: process.env.THIS_THAT_BASE_URL ?? 'http://127.0.0.1:8767',
    framesPerDecision: process.env.FRAMES_PER_DECISION ?? 16,
    maxDecisions: process.env.MAX_DECISIONS ?? 3000,
    experienceEnabled:
      integer(process.env.USE_EXPERIENCE ?? 0, 'USE_EXPERIENCE', 0, 1) === 1,
    logDirectory: fileURLToPath(new URL('midscene_run/logs/', root)),
    experienceDirectory: fileURLToPath(
      new URL('midscene_run/experience/', root),
    ),
  });
  if (process.env.MARIO_ROM) {
    try {
      game.load(await readFile(process.env.MARIO_ROM));
    } catch (error) {
      throw new Error(`Cannot load MARIO_ROM: ${error.message}`, {
        cause: error,
      });
    }
  }
  const port = integer(process.env.GAME_PORT ?? 4175, 'GAME_PORT', 1, 65535);
  const server = createGameServer(game);
  await listen(server, port);
  console.log(`Local This-That Mario: http://127.0.0.1:${port}`);
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
