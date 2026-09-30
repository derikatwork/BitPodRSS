import { describe, expect, it } from 'vitest';
import { npubOf, parseProfile, parsePubkey } from './nostr';

// Test vector from the NIP-19 specification.
const HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';

describe('parsePubkey', () => {
  it('converts npub <-> hex per NIP-19', () => {
    expect(npubOf(HEX)).toBe(NPUB);
    expect(parsePubkey(NPUB)).toBe(HEX);
  });
  it('accepts hex, nostr: URIs and surrounding whitespace', () => {
    expect(parsePubkey(HEX.toUpperCase())).toBe(HEX);
    expect(parsePubkey(`  nostr:${NPUB}\n`)).toBe(HEX);
  });
  it('rejects private keys (never accept an nsec), garbage and wrong lengths', () => {
    expect(() => parsePubkey(NSEC)).toThrow(/public key/);
    expect(() => parsePubkey('hello')).toThrow(/valid npub/);
    expect(() => parsePubkey('abcd')).toThrow(/valid npub/);
    expect(() => parsePubkey('')).toThrow();
  });
});

describe('parseProfile', () => {
  it('reads the fields we show and ignores the rest', () => {
    expect(parseProfile(JSON.stringify({ name: 'sam', display_name: 'Sam S', picture: 'https://x.example/a.png', nip05: 'sam@x.example', lud16: 'sam@getalby.com', about: ' hi ', website: 'https://ignored' }))).toEqual({
      name: 'sam',
      displayName: 'Sam S',
      picture: 'https://x.example/a.png',
      about: 'hi',
      nip05: 'sam@x.example',
      lud16: 'sam@getalby.com',
    });
  });
  it('drops non-http(s) picture URLs (no javascript:/data: avatars) and survives bad JSON or wrong types', () => {
    expect(parseProfile(JSON.stringify({ picture: 'javascript:alert(1)' })).picture).toBeUndefined();
    expect(parseProfile(JSON.stringify({ picture: 'data:image/png;base64,AAAA' })).picture).toBeUndefined();
    expect(parseProfile('{not json')).toEqual({});
    expect(parseProfile(JSON.stringify({ name: 42, about: null }))).toEqual({});
  });
});
