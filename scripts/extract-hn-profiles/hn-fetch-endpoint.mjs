// Where the extraction scripts reach String Web Access. Two surfaces answer the same
// /fetch contract: the hosted API, which needs our org key, and a local shim on :7654,
// which carries no auth and no org. worker.js already calls the hosted one in production;
// this exists so the scripts can reach it too, rather than requiring a shim to be running.

const HOSTED_API = 'https://request.usestring.ai/v1';
const LOCAL_SHIM = 'http://localhost:7654';

// The key is sent to the hosted origin and nowhere else. UNBLOCKER_URL therefore selects an
// unauthenticated shim rather than re-pointing the credential: a mistyped or hostile value in
// the environment can route the request somewhere unintended, but it cannot carry the org key
// there.
export function resolveFetchTarget(env = process.env) {
  const key = (env.UNBLOCKER_ORG_API_KEY || env.STRING_UNBLOCKER_API_KEY || '').trim();
  const override = (env.UNBLOCKER_URL || '').trim();
  const base = override || (key ? HOSTED_API : LOCAL_SHIM);
  const authenticated = !override && Boolean(key);

  return {
    endpoint: `${base.replace(/\/+$/, '')}/fetch`,
    headers: authenticated
      ? { 'content-type': 'application/json', authorization: `Bearer ${key}` }
      : { 'content-type': 'application/json' },
    authenticated
  };
}
