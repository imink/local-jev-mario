import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateROM } from '../browser/core.mjs';
import { AUDIT, exportHistory } from './public-history.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const log = process.env.MARIO_REPLAY_LOG;
if (
  process.env.MARIO_ROM_DISTRIBUTION_AUTHORIZED !== 'true' ||
  !process.env.MARIO_PUBLIC_ROM
)
  throw new Error(
    'Public hosting requires distribution rights: set MARIO_ROM_DISTRIBUTION_AUTHORIZED=true and MARIO_PUBLIC_ROM to the authorized .nes file. The ROM is not committed to Git.',
  );
const romPath = resolve(process.env.MARIO_PUBLIC_ROM);
if ((await stat(romPath)).size !== 40976)
  throw new Error('Public ROM must be exactly 40976 bytes.');
const rom = new Uint8Array(await readFile(romPath));
validateROM(rom);
if ((await sha256(rom)) !== AUDIT.romSHA256)
  throw new Error('Public ROM differs from the audited campaign ROM.');
if (!log)
  throw new Error(
    'Set MARIO_REPLAY_LOG to the private audited campaign JSONL. No runtime directory is copied to the site.',
  );
await mkdir(join(root, '.cloudflare'), { recursive: true });
const temporary = await mkdtemp(join(root, '.cloudflare/build-'));
try {
  const manifest = await exportHistory(
    resolve(log),
    join(temporary, 'history'),
  );
  const files = {
    'browser/index.html': 'index.html',
    'browser/_headers': '_headers',
    'browser/app.mjs': 'browser/app.mjs',
    'browser/assets.mjs': 'browser/assets.mjs',
    'browser/core.mjs': 'browser/core.mjs',
    'browser/i18n.mjs': 'browser/i18n.mjs',
    'browser/style.css': 'browser/style.css',
    'telemetry.mjs': 'telemetry.mjs',
    'node_modules/jsnes/dist/jsnes.js': 'vendor/jsnes.js',
    'node_modules/jsnes/LICENSE': 'vendor/JSNES-LICENSE',
  };
  for (const [source, target] of Object.entries(files)) {
    await mkdir(dirname(join(temporary, target)), { recursive: true });
    await cp(join(root, source), join(temporary, target), {
      dereference: true,
    });
  }
  await mkdir(join(temporary, 'rom'));
  await writeFile(join(temporary, 'rom/game.nes'), rom);
  const expected = new Set([
    ...Object.values(files),
    'rom/game.nes',
    'history/manifest.json',
    ...manifest.chunks.map((c) => `history/${c.file}`),
  ]);
  let bytes = 0;
  for (const path of await readdir(temporary, { recursive: true })) {
    const info = await stat(join(temporary, path));
    if (!info.isFile()) continue;
    if (!expected.delete(path))
      throw new Error('Unexpected public build file.');
    bytes += info.size;
  }
  if (expected.size) throw new Error('Incomplete public build.');
  const destination = join(root, '.cloudflare/site');
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  console.log(
    JSON.stringify(
      {
        directory: '.cloudflare/site',
        decisions: manifest.totalDecisions,
        events: manifest.totalEvents,
        chunks: manifest.chunks.length,
        bytes,
        sourceSHA256: manifest.sourceSHA256,
        note: 'Reviewed static assets, explicitly authorized ROM and allowlisted gameplay data; no snapshots, credentials or raw logs.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
