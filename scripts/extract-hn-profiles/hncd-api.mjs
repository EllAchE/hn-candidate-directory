#!/usr/bin/env node
// The only script that touches HN_INGEST_TOKEN. It never reads comment text, resume
// text, or model output beyond validating the envelope, so the credential and the
// untrusted content never occupy the same process.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `usage:
  hncd-api.mjs pending [--extractor <id>] [--host <https://host>]
  hncd-api.mjs push --file <push-payload.json> [--host <https://host>]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else args._.push(token);
  }
  return args;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function resolveHost(args) {
  const host = args.host || process.env.HNCD_HOST;
  if (!host) fail('set --host or HNCD_HOST to the worker origin (OPERATIONS.md keeps the hostname out of the repo)');
  const parsed = new URL(host);
  if (parsed.protocol !== 'https:') fail('the worker host must be https');
  return parsed.origin;
}

// Env first so a run can scope the credential to one shell. The file fallback exists
// because a token exported into every shell is a token every subprocess inherits.
function resolveToken() {
  const fromEnv = process.env.HNCD_INGEST_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return readFileSync(join(homedir(), '.config', 'hncd', 'ingest-token'), 'utf8').trim();
  } catch {
    return fail('no credential: export HNCD_INGEST_TOKEN or write ~/.config/hncd/ingest-token (chmod 600)');
  }
}

async function call(host, path, token, init = {}) {
  const response = await fetch(`${host}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`${path} returned ${response.status} with a non-JSON body`);
  }
  if (!response.ok) fail(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function pending(args) {
  const extractor = args.extractor || 'claude-skill-v1';
  const body = await call(
    resolveHost(args),
    `/api/admin/profiles/hn/pending?extractor=${encodeURIComponent(extractor)}`,
    resolveToken()
  );
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function push(args) {
  if (!args.file) fail(USAGE);
  const payload = JSON.parse(readFileSync(args.file, 'utf8'));
  if (!payload?.extractor || !Array.isArray(payload?.profiles) || !payload.profiles.length) {
    fail(`${args.file} is not a push payload: expected {extractor, profiles: [...]}`);
  }
  const body = await call(resolveHost(args), '/api/admin/profiles/hn', resolveToken(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command === 'pending') await pending(args);
else if (command === 'push') await push(args);
else fail(USAGE, 2);
