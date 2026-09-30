import * as nip19 from 'nostr-tools/nip19';
import type { Nip07 } from './wallet';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export interface NostrProfile {
  name?: string;
  displayName?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  /** Lightning address from the profile. */
  lud16?: string;
}

export function nip07Available(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

/** Ask the user's Nostr signer (NIP-07 browser extension, e.g. Alby) for their public key. */
export async function getNip07Pubkey(): Promise<string> {
  const nostr: Nip07 | undefined = window.nostr;
  if (!nostr) throw new Error('No Nostr signer found. Install a NIP-07 browser extension such as Alby, or paste your npub instead.');
  const pubkey = await nostr.getPublicKey();
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error('The signer returned an invalid public key.');
  return pubkey.toLowerCase();
}

export const npubOf = (pubkeyHex: string): string => nip19.npubEncode(pubkeyHex);

/** Accept an npub (or a raw 64-character hex key) and return the hex public key. */
export function parsePubkey(input: string): string {
  const v = input.trim().replace(/^nostr:/i, '');
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  let decoded;
  try {
    decoded = nip19.decode(v);
  } catch {
    throw new Error('That is not a valid npub.');
  }
  if (decoded.type === 'npub') return decoded.data;
  if (decoded.type === 'nprofile') return decoded.data.pubkey;
  throw new Error('Please paste your public key (npub…), not a private key or note id.');
}

/** Extract the profile fields we use from a kind-0 event's JSON content. */
export function parseProfile(content: string): NostrProfile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
  const picture = str('picture');
  return {
    name: str('name'),
    displayName: str('display_name') ?? str('displayName'),
    picture: picture && /^https?:\/\//i.test(picture) ? picture : undefined,
    about: str('about'),
    nip05: str('nip05'),
    lud16: str('lud16'),
  };
}

/** Fetch the user's profile (kind 0) from public relays. Resolves to undefined if nothing answers in time. */
export async function fetchProfile(pubkey: string, relays: string[] = DEFAULT_RELAYS, timeoutMs = 6000): Promise<NostrProfile | undefined> {
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  try {
    const event = await Promise.race([
      pool.get(relays, { kinds: [0], authors: [pubkey] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return event ? parseProfile(event.content) : undefined;
  } finally {
    pool.close(relays);
  }
}

export interface PublishResult {
  ok: string[];
  failed: string[];
}

/** Sign a text note with the user's NIP-07 signer (which asks them to approve) and publish it to relays. */
export async function publishNote(content: string, tags: string[][] = [], relays: string[] = DEFAULT_RELAYS): Promise<PublishResult> {
  const nostr = window.nostr;
  if (!nostr) throw new Error('A Nostr signer extension is required to publish.');
  const event = await nostr.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content });
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  try {
    const settled = await Promise.allSettled(pool.publish(relays, event));
    const result: PublishResult = { ok: [], failed: [] };
    settled.forEach((s, i) => (s.status === 'fulfilled' ? result.ok : result.failed).push(relays[i]!));
    return result;
  } finally {
    pool.close(relays);
  }
}
