/**
 * Optional server-side adapter for the static directory.
 *
 * Deploy this handler behind the same origin as who-is-hiring.html and set
 * `window.HN_ENRICH_ENDPOINT` to its URL. The browser never receives the
 * String API key. The handler is deliberately small: fetching through String
 * is the transport boundary; PDF/HTML-to-fields extraction can be swapped in
 * behind `extractFields` without changing the directory UI.
 *
 * Required environment variables:
 *   UNBLOCKER_API_URL (default: https://request.usestring.ai/v1)
 *   UNBLOCKER_ORG_API_KEY
 */

const MAX_SOURCE_BYTES = 2_000_000;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const origin = request.headers.get('Origin');
    if (origin && !new URL(request.url).origin.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);
    const body = await request.json().catch(() => null);
    const url = typeof body?.url === 'string' ? body.url : '';
    if (!/^https?:\/\//i.test(url)) return json({ error: 'valid_http_url_required' }, 400);

    const upstream = await fetch(`${env.UNBLOCKER_API_URL || 'https://request.usestring.ai/v1'}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.UNBLOCKER_ORG_API_KEY}` },
      body: JSON.stringify({ url, format: 'raw' })
    });
    if (!upstream.ok) return json({ error: 'string_fetch_failed', status: upstream.status }, 502);
    const envelope = await upstream.json();
    const text = typeof envelope.data === 'string' ? envelope.data.slice(0, MAX_SOURCE_BYTES) : JSON.stringify(envelope.data || {}).slice(0, MAX_SOURCE_BYTES);
    return json({ text, source: url, processor: 'string-unblocker', fields: extractFields(text) });
  }
};

function extractFields(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    universities: lines.filter((line) => /university|college|institute/i.test(line)).slice(0, 10),
    companies: lines.filter((line) => /worked|experience|previous|formerly|at /i.test(line)).slice(0, 10),
    skills: lines.filter((line) => /skills|technologies|stack|proficient/i.test(line)).slice(0, 10)
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
}
