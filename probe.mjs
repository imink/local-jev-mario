import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { decisionConfig } from './official-jev.mjs';
import { checkJev, choose } from './policy.mjs';
import { Telemetry } from './telemetry.mjs';

// Synthetic RAM, not a game recording or a bundled ROM.
const ram = new Uint8Array(2048);
ram[0x770] = 1;
ram[0x772] = 3;
ram[0x0e] = 8;
ram[0xb5] = 1;
ram[0x86] = 40;
ram[0xce] = 192;
ram[0x754] = 1;
ram[0x75a] = 2;
ram[0x7f8] = 4;
for (let column = 0; column < 16; column++)
  ram[0x500 + 12 * 16 + column] = 0x54;
const state = new Telemetry(16).sample(ram, 0);
state.probe =
  'Synthetic RAM contract probe; NOT evidence of real Mario gameplay.';
const config = decisionConfig();
const health = await checkJev(config.baseURL, config);
const runId = randomUUID();
const decision = await choose(state, { ...config, runId });
const evidence = { runId, health, state, decision };
const directory = new URL('./midscene_run/probes/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL(`${runId}.json`, directory),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
