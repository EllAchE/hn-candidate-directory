// Shared handling for attacker-controlled bytes. Nothing here interprets content; it
// only makes hostile text visible and keeps URLs off the network until they are screened.

import { randomBytes } from 'node:crypto';

export const TEXT_CAP = 8_000;
export const RESUME_CAP = 24_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", '#x2F': '/', nbsp: ' ' };

export function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    const numeric = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(numeric) && numeric > 0 && numeric < 0x110000 ? String.fromCodePoint(numeric) : ' ';
  });
}

export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  );
}

const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]', 'g');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

// White-on-white text and off-page divs survive a human spot-check; zero-width and bidi
// runs survive one too, and every one of them reads perfectly to a model. Strip rather
// than reject, so a candidate with one unlucky character still gets a profile.
export function neutralize(value, cap = TEXT_CAP) {
  return String(value || '')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, cap);
}

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|metadata\.(google|aws)\.internal)$/i;

// A resume is served from a hostname, never from a bare address, so every IP literal is
// refused outright instead of range-checked. Enumerating private ranges is what let
// `https://[::ffff:127.0.0.1]/` through -- loopback wearing an IPv6 costume, matching none of
// `::1`, `fc00::/7`, or `fe80::/10`. Refusing the whole shape also makes this agree with the
// Worker's `isBlockedNetworkHost`, which already blocks every dotted quad and every host
// containing a colon; two screens in one repo disagreeing about what is reachable is the
// condition under which the weaker one gets used by mistake.
//
// Decimal and hex forms (`2130706433`, `0x7f000001`, `127.1`) need no separate case: the URL
// parser normalizes them to a dotted quad before this sees them.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function screenUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.href.length > 2_048) return null;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOST.test(host)) return null;
  if (IPV4_LITERAL.test(host)) return null;
  if (host.includes(':')) return null;
  return parsed.href;
}

const LINK_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const HREF_PATTERN = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

// Takes the raw comment HTML, not the rendered text: HN elides a long URL in the anchor text
// it displays, so a Google Drive share link read from the text is truncated and unfetchable.
export function screenedLinks(html, limit = 12) {
  const source = String(html || '');
  const seen = new Set();
  const links = [];

  const add = (raw, isHref) => {
    if (links.length >= limit) return;
    const screened = screenUrl(String(raw ?? '').replace(/[.,;:]+$/, ''));
    if (!screened || seen.has(screened)) return;
    // A bare-text match that is a prefix of a collected href is that link with its display
    // elided, not a second destination.
    if (!isHref && [...seen].some((known) => known.startsWith(screened))) return;
    seen.add(screened);
    links.push({ index: links.length + 1, url: screened });
  };

  for (const match of source.matchAll(HREF_PATTERN)) add(decodeEntities(match[1] ?? match[2] ?? match[3]), true);
  // Reading rendered text on the second pass finds bare URLs in prose without re-matching
  // each href in its still-encoded form.
  for (const match of htmlToText(source).matchAll(LINK_PATTERN)) add(match[0], false);
  return links;
}

export const nonce = () => randomBytes(9).toString('hex');

// A per-run delimiter the payload cannot forge, so untrusted bytes cannot close their own
// data block and continue as instructions.
export const delimiter = () => `HNCD-${randomBytes(6).toString('hex').toUpperCase()}`;
