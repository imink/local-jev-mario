import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export const OFFICIAL_JEV_URL = 'https://api.typesafe.ai';
export const DEFAULT_JEV_MODEL = 'jev-1.14.0';

function redactErrorText(value, apiKey, limit) {
  const variants = [
    apiKey,
    JSON.stringify(apiKey).slice(1, -1),
    encodeURIComponent(apiKey),
    Buffer.from(apiKey).toString('base64'),
  ];
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let text = String(value).replace(
    /&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_match, hex, decimal, named) => {
      if (named) return entities[named.toLowerCase()];
      const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    },
  );
  for (const secret of variants) text = text.split(secret).join('[redacted]');
  text = text.replace(/\bBearer\s+\S+/gi, '[redacted]');
  text = text
    .split(/\r?\n/)
    .map((line) =>
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\b/i.test(
        line,
      ) ||
      /\b(?:(?:[a-z0-9]+[_-])*api[_ -]?key|token|secret|password)["']?\s*[:=]/i.test(
        line,
      )
        ? '[redacted sensitive field]'
        : line,
    )
    .join(' ');
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

async function officialErrorDetails(response, apiKey) {
  if (!response.body) return { bodyStatus: 'empty' };
  const reader = response.body.getReader();
  const expired = Symbol('error-body-timeout');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(expired), 2000);
  });
  let bodyStatus = 'complete';
  const chunks = [];
  let size = 0;
  let reads = 0;
  try {
    for (;;) {
      if (reads++ === 64) {
        bodyStatus = 'too_fragmented';
        break;
      }
      const result = await Promise.race([reader.read(), deadline]);
      if (result === expired) {
        bodyStatus = 'timed_out';
        break;
      }
      if (result.done) break;
      if (size + result.value.byteLength > 4096) {
        bodyStatus = 'too_large';
        break;
      }
      chunks.push(result.value);
      size += result.value.byteLength;
    }
  } catch {
    bodyStatus = 'read_failed';
  }
  const cleanup = await Promise.race([
    reader.cancel().then(
      () => 'complete',
      () => 'failed',
    ),
    deadline,
  ]);
  clearTimeout(timer);
  const details = {
    bodyStatus,
    ...(cleanup !== 'complete'
      ? { cleanup: cleanup === expired ? 'timed_out' : cleanup }
      : {}),
  };
  if (bodyStatus !== 'complete') return details;
  const text = Buffer.concat(chunks, size).toString('utf8').trim();
  if (!text) return { ...details, bodyStatus: 'empty' };
  let fields;
  if (/^[{[]/.test(text)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...details, bodyStatus: 'invalid_json' };
    }
    const error = parsed?.error;
    const source = error && typeof error === 'object' ? error : parsed;
    fields = {
      type: source?.type,
      code: source?.code,
      message:
        typeof error === 'string' ? error : (source?.message ?? source?.detail),
    };
  } else if (text.startsWith('<')) {
    fields = { message: text.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1] };
    details.bodyStatus = 'html_title_only';
  } else {
    fields = { message: text };
  }
  for (const [key, value] of Object.entries(fields))
    if (typeof value === 'string' || typeof value === 'number')
      details[key] = redactErrorText(
        value,
        apiKey,
        key === 'message' ? 512 : 64,
      );
  return details;
}

export function validateOfficialConfig(apiKey, model) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[^!-~]/.test(apiKey))
    throw new Error('Set a valid TYPESAFE_API_KEY for official Jev.');
  if (
    typeof model !== 'string' ||
    !/^jev-(?:latest|preview|\d+\.\d+\.\d+)$/.test(model)
  )
    throw new Error('JEV_MODEL must be a Jev version or official alias.');
}

export function decisionConfig(env = process.env) {
  const backend = env.DECISION_BACKEND ?? 'this-that';
  if (backend === 'this-that')
    return {
      backend,
      baseURL: env.THIS_THAT_BASE_URL ?? 'http://127.0.0.1:8767',
    };
  if (backend !== 'jev-official')
    throw new Error('DECISION_BACKEND must be this-that or jev-official.');
  let apiKey = env.TYPESAFE_API_KEY;
  if (env.TYPESAFE_ENV_FILE)
    apiKey = parseEnv(
      readFileSync(env.TYPESAFE_ENV_FILE, 'utf8'),
    ).TYPESAFE_API_KEY;
  const model = env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
  validateOfficialConfig(apiKey, model);
  return { backend, baseURL: OFFICIAL_JEV_URL, apiKey, model };
}

export async function officialRequest(path, { apiKey, signal, body } = {}) {
  if (!['/v1/systemone', '/v1/models'].includes(path))
    throw new Error('Unsupported official Jev API path.');
  validateOfficialConfig(apiKey, body?.model ?? DEFAULT_JEV_MODEL);
  let response;
  try {
    response = await fetch(`${OFFICIAL_JEV_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        // Do not retain pooled sockets across synchronous emulator forecasts.
        Connection: 'close',
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.any([
        AbortSignal.timeout(125000),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch (error) {
    // Do not expose transport errors that could contain authentication headers.
    const knownCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ];
    const reason =
      error?.name === 'TimeoutError'
        ? 'timeout'
        : knownCodes.includes(error?.cause?.code)
          ? error.cause.code
          : 'transport';
    throw new Error(
      signal?.aborted
        ? 'Official Jev request aborted.'
        : `Official Jev network request failed (${reason}); no fallback was used.`,
    );
  }
  if (!response.ok) {
    const details = await officialErrorDetails(response, apiKey);
    throw new Error(
      `Official Jev HTTP ${response.status}; agent stopped. ${JSON.stringify(details)}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error('Official Jev returned invalid JSON.');
  }
}
