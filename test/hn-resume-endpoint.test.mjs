#!/usr/bin/env node
// Which surface the resume fetch talks to, and the rule that keeps the org key off every
// surface but the hosted one.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFetchTarget } from '../scripts/extract-hn-profiles/hn-fetch-endpoint.mjs';

test('falls back to the local shim, unauthenticated, when no key is configured', () => {
  const target = resolveFetchTarget({});
  assert.equal(target.endpoint, 'http://localhost:7654/fetch');
  assert.equal(target.authenticated, false);
  assert.equal(target.headers.authorization, undefined);
});

test('a configured org key selects the hosted API and is sent as a bearer token', () => {
  const target = resolveFetchTarget({ UNBLOCKER_ORG_API_KEY: 'org-key' });
  assert.equal(target.endpoint, 'https://request.usestring.ai/v1/fetch');
  assert.equal(target.authenticated, true);
  assert.equal(target.headers.authorization, 'Bearer org-key');
});

test('STRING_UNBLOCKER_API_KEY works too, with the project name winning', () => {
  assert.equal(resolveFetchTarget({ STRING_UNBLOCKER_API_KEY: 'fallback' }).headers.authorization, 'Bearer fallback');
  assert.equal(
    resolveFetchTarget({ UNBLOCKER_ORG_API_KEY: 'primary', STRING_UNBLOCKER_API_KEY: 'fallback' }).headers.authorization,
    'Bearer primary'
  );
});

// The load-bearing one: UNBLOCKER_URL picks a shim, it does not re-point the credential.
test('an explicit UNBLOCKER_URL never receives the org key', () => {
  const target = resolveFetchTarget({ UNBLOCKER_URL: 'http://127.0.0.1:9999', UNBLOCKER_ORG_API_KEY: 'org-key' });
  assert.equal(target.endpoint, 'http://127.0.0.1:9999/fetch');
  assert.equal(target.authenticated, false);
  assert.equal(target.headers.authorization, undefined);
});

test('a trailing slash on the base does not produce a doubled path', () => {
  assert.equal(resolveFetchTarget({ UNBLOCKER_URL: 'http://localhost:7654/' }).endpoint, 'http://localhost:7654/fetch');
});

test('blank env values are treated as absent, not as an empty bearer', () => {
  const target = resolveFetchTarget({ UNBLOCKER_URL: '  ', UNBLOCKER_ORG_API_KEY: '  ' });
  assert.equal(target.endpoint, 'http://localhost:7654/fetch');
  assert.equal(target.authenticated, false);
});
