import { pathToFileURL } from 'node:url';

const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 5_000, maxBytes: 1_000_000 });
const MAX_ASSET_REQUESTS = 16;
const REQUIRED_CANDIDATE_FIELDS = Object.freeze({
  id: 'string',
  name: 'string',
  role: 'string',
  summary: 'string',
  location: 'string',
  mode: 'string',
  availability: 'string',
  university: 'string',
  universities: 'stringArray',
  companies: 'stringArray',
  skills: 'stringArray',
  dateRanges: 'stringArray',
  source: 'string',
  enriched: 'boolean',
  posted: 'number',
  publishedAt: 'string'
});
const PRIVATE_KEYS = new Set([
  'apikey',
  'authorization',
  'email',
  'objectkey',
  'phone',
  'reviewtoken',
  'reviewtokenhash',
  'secret',
  'sourcetext',
  'status',
  'submissionid',
  'token'
]);

export async function runStagingSmoke(baseUrlInput, limits = DEFAULT_LIMITS) {
  const baseUrl = validateBaseUrl(baseUrlInput);
  const html = await fetchText(baseUrl, 'directory HTML', 'text/html', limits);
  const assetUrls = extractAssetUrls(html, baseUrl);

  if (assetUrls.length > MAX_ASSET_REQUESTS) {
    throw new Error(`directory HTML references more than ${MAX_ASSET_REQUESTS} assets`);
  }
  if (!assetUrls.some((url) => url.pathname.endsWith('.css'))) throw new Error('directory HTML has no stylesheet asset');
  if (!assetUrls.some((url) => url.pathname.endsWith('.js'))) throw new Error('directory HTML has no script asset');

  await Promise.all(
    assetUrls.map((url) =>
      fetchText(url, `asset ${url.pathname}`, url.pathname.endsWith('.css') ? 'text/css' : 'javascript', limits)
    )
  );

  const candidatesUrl = new URL('/api/candidates', baseUrl);
  const payloadText = await fetchText(candidatesUrl, 'candidate API', 'application/json', limits, requireNoStore);
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('candidate API returned malformed JSON');
  }
  validateCandidatePayload(payload);

  return { assets: assetUrls.length, candidates: payload.candidates.length };
}

function validateBaseUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('base URL must be an absolute URL');
  }

  if (url.username || url.password) throw new Error('base URL must not contain credentials');
  if (url.hash || url.search) throw new Error('base URL must not contain a query or fragment');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base URL must use HTTPS');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !loopback) throw new Error('base URL must use HTTPS except for loopback tests');
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function extractAssetUrls(html, baseUrl) {
  const references = [
    ...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi),
    ...html.matchAll(/<link\b(?=[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)
  ].map((match) => match[1]);

  return [...new Set(references)].map((reference) => {
    const url = new URL(reference, baseUrl);
    if (url.origin !== baseUrl.origin) throw new Error(`directory HTML references cross-origin asset ${url.href}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`directory HTML references unsupported asset ${url.href}`);
    url.hash = '';
    return url;
  });
}

async function fetchText(url, label, expectedContentType, limits, validateHeaders = () => {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      let destination = 'unknown destination';
      if (location) {
        try {
          const target = new URL(location, url);
          destination = target.origin === url.origin ? target.pathname : target.origin;
        } catch {
          destination = 'invalid destination';
        }
      }
      await response.body?.cancel();
      throw new Error(`${label} redirected to ${destination}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    if (response.url && new URL(response.url).origin !== url.origin) {
      await response.body?.cancel();
      throw new Error(`${label} crossed origins`);
    }
    requireContentType(response, expectedContentType, label);
    validateHeaders(response);
    return await readBoundedText(response, label, limits.maxBytes);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`${label} timed out`);
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} request failed`);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedText(response, label, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (/^\d+$/.test(contentLength || '') && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function requireContentType(response, expected, label) {
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes(expected)) throw new Error(`${label} returned unexpected content type`);
}

function requireNoStore(response) {
  const directives = (response.headers.get('cache-control') || '')
    .split(',')
    .map((directive) => directive.trim().toLowerCase());
  if (!directives.includes('no-store')) throw new Error('candidate API is missing Cache-Control: no-store');
}

function validateCandidatePayload(payload) {
  if (!isPlainObject(payload) || Object.keys(payload).length !== 1 || !Array.isArray(payload.candidates)) {
    throw new Error('candidate API payload must contain only a candidates array');
  }
  rejectPrivateKeys(payload, 'payload');
  payload.candidates.forEach((candidate, index) => validateCandidate(candidate, index));
}

function validateCandidate(candidate, index) {
  if (!isPlainObject(candidate)) throw new Error(`candidate ${index} is not an object`);
  const expectedKeys = Object.keys(REQUIRED_CANDIDATE_FIELDS).sort();
  const actualKeys = Object.keys(candidate).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
    throw new Error(`candidate ${index} does not match the public shape`);
  }

  Object.entries(REQUIRED_CANDIDATE_FIELDS).forEach(([key, type]) => {
    const value = candidate[key];
    const valid = type === 'stringArray' ? Array.isArray(value) && value.every((item) => typeof item === 'string') : typeof value === type;
    if (!valid) throw new Error(`candidate ${index} has invalid ${key}`);
  });
}

function rejectPrivateKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  Object.entries(value).forEach(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PRIVATE_KEYS.has(normalizedKey)) throw new Error(`candidate API exposed private key ${path}.${key}`);
    rejectPrivateKeys(nested, `${path}.${key}`);
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error('Usage: bun run smoke:staging -- https://staging.example.com');
    process.exitCode = 2;
  } else {
    runStagingSmoke(baseUrl)
      .then(({ assets, candidates }) => console.log(`Staging smoke passed: ${assets} assets, ${candidates} public candidates`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'Staging smoke failed');
        process.exitCode = 1;
      });
  }
}
