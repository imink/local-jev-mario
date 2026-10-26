import { sha256, validateROM } from './core.mjs';

export async function boundedBytes(url, limit) {
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-cache',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Static data HTTP ${response.status}.`);
  if (!response.body) throw new Error('Static response has no body.');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Static data exceeds its size limit.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function loadHostedROM(expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? ''))
    throw new Error('Hosted ROM requires a valid audit hash.');
  const bytes = await boundedBytes('./rom/game.nes', 40976);
  validateROM(bytes);
  const hash = await sha256(bytes);
  if (hash !== expectedHash) throw new Error('Hosted ROM SHA-256 differs.');
  return { bytes, hash };
}
