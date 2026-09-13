import { describe, expect, it } from 'bun:test';
import { classifySource, isUnextractable } from '../scripts/extract-hn-profiles/hn-check-sources.mjs';

// 28 of the 100 items on the first pending page of the 2026-09-07 backfill classified as
// deleted, against 54 of 1,591 published profiles. Those are the shapes Firebase actually
// returned for them, so they are the shapes worth pinning.
describe('classifySource', () => {
  it('reads an author deletion as deleted', () => {
    expect(classifySource({ deleted: true, time: 1786710529 })).toBe('deleted');
  });

  it('separates a moderator kill from an author deletion', () => {
    expect(classifySource({ dead: true, by: 'someone', text: 'still here' })).toBe('dead');
  });

  it('treats an id Firebase does not know as missing', () => {
    expect(classifySource(null)).toBe('missing');
    expect(classifySource(undefined)).toBe('missing');
  });

  // A deleted item comes back with every field null, so `deleted` has to be checked before the
  // text -- reading this as `no_text` would lose the one fact that says the author withdrew it.
  it('prefers the deletion flag over the empty text it also implies', () => {
    expect(classifySource({ deleted: true, by: null, text: null })).toBe('deleted');
  });

  it('flags an item with no text even when nothing marks it', () => {
    expect(classifySource({ by: 'someone', text: '' })).toBe('no_text');
    expect(classifySource({ by: 'someone' })).toBe('no_text');
  });

  it('passes an ordinary live comment', () => {
    expect(classifySource({ by: 'someone', text: 'Location: Berlin\nRemote: yes' })).toBe('ok');
  });

  // `dead: false` and `deleted: false` are present on ordinary items; only `true` counts.
  it('does not read a false flag as set', () => {
    expect(classifySource({ deleted: false, dead: false, text: 'Location: Berlin' })).toBe('ok');
  });
});

describe('isUnextractable', () => {
  it('is true for every verdict but ok', () => {
    for (const verdict of ['deleted', 'dead', 'missing', 'no_text']) {
      expect(isUnextractable(verdict)).toBe(true);
    }
    expect(isUnextractable('ok')).toBe(false);
  });
});
