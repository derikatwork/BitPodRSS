import type { ValueBlock, ValueRecipient } from './types';

/** TLV record type used for boostagram metadata (BLIP-10 / Podcasting 2.0 value spec). */
export const BOOSTAGRAM_TLV = 7629169;

export interface RecipientPayment {
  recipient: ValueRecipient;
  sats: number;
}

/**
 * Convert the spec's `suggested` attribute (a decimal amount of BTC per minute, e.g. "0.00000015000")
 * to whole sats.
 */
export function satsFromSuggested(suggested: string | number | undefined): number | undefined {
  if (suggested == null || suggested === '') return undefined;
  const btc = typeof suggested === 'number' ? suggested : Number.parseFloat(suggested);
  if (!Number.isFinite(btc) || btc <= 0) return undefined;
  return Math.round(btc * 1e8);
}

/**
 * Divide `totalSats` between a value block's recipients.
 *
 * Fee recipients (`fee="true"`) are paid first, each taking `split` percent of the total. The remainder
 * is shared between the other recipients in proportion to their `split` shares. Integer sats are
 * allocated with the largest-remainder method so the amounts always add up exactly, and recipients
 * whose share rounds to zero are dropped (nothing is paid to them).
 */
export function computeSplits(totalSats: number, recipients: readonly ValueRecipient[]): RecipientPayment[] {
  const total = Math.floor(totalSats);
  if (!Number.isFinite(total) || total <= 0) return [];
  const valid = recipients.filter((r) => r.address && Number.isFinite(r.split) && r.split > 0);

  const payments = new Map<ValueRecipient, number>();
  let remaining = total;

  for (const r of valid.filter((x) => x.fee)) {
    const fee = Math.min(remaining, Math.floor((total * r.split) / 100));
    if (fee > 0) {
      payments.set(r, fee);
      remaining -= fee;
    }
  }

  const shareholders = valid.filter((x) => !x.fee);
  const totalShares = shareholders.reduce((sum, r) => sum + r.split, 0);
  if (shareholders.length && totalShares > 0 && remaining > 0) {
    const exact = shareholders.map((r) => ({ r, amount: (remaining * r.split) / totalShares }));
    const floors = exact.map((e) => ({ ...e, floor: Math.floor(e.amount), frac: e.amount - Math.floor(e.amount) }));
    let leftover = remaining - floors.reduce((s, f) => s + f.floor, 0);
    for (const f of [...floors].sort((a, b) => b.frac - a.frac || b.r.split - a.r.split)) {
      if (leftover <= 0) break;
      f.floor += 1;
      leftover -= 1;
    }
    for (const f of floors) if (f.floor > 0) payments.set(f.r, (payments.get(f.r) ?? 0) + f.floor);
  }

  return valid.filter((r) => payments.has(r)).map((r) => ({ recipient: r, sats: payments.get(r)! }));
}

export interface BoostagramInput {
  appName: string;
  appVersion?: string;
  action: 'boost' | 'stream';
  podcast: string;
  feedUrl?: string;
  feedGuid?: string;
  episode?: string;
  episodeGuid?: string;
  /** Playback position in seconds. */
  ts?: number;
  message?: string;
  senderName?: string;
  /** Sender's Nostr pubkey (hex), if the user connected an identity. */
  senderNostrPubkey?: string;
  /** This recipient's name from the value block. */
  recipientName?: string;
  valueMsat: number;
  valueMsatTotal: number;
  speed?: number;
}

/**
 * Keysend custom records ride in the Lightning onion payload, which has roughly 1300 bytes for everything.
 * Stay well inside that so long titles or messages cannot make an otherwise valid payment fail.
 */
export const MAX_BOOSTAGRAM_BYTES = 900;

const clip = (s: string | undefined, max: number): string | undefined => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Build the JSON carried in TLV record 7629169. Undefined fields are omitted; the result is size-bounded. */
export function buildBoostagram(b: BoostagramInput): string {
  const payload: Record<string, unknown> = {
    action: b.action,
    app_name: b.appName,
    app_version: b.appVersion,
    podcast: clip(b.podcast, 80),
    url: clip(b.feedUrl, 160),
    guid: b.feedGuid,
    episode: clip(b.episode, 80),
    episode_guid: clip(b.episodeGuid, 80),
    ts: b.ts != null ? Math.floor(b.ts) : undefined,
    name: b.recipientName,
    sender_name: clip(b.senderName, 40),
    sender_id: b.senderNostrPubkey,
    message: b.message,
    value_msat: b.valueMsat,
    value_msat_total: b.valueMsatTotal,
    speed: b.speed != null ? String(b.speed) : undefined,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined || payload[k] === '') delete payload[k];

  // Still too big (mostly a long message)? Drop the least useful metadata first, then shorten the message.
  let json = JSON.stringify(payload);
  for (const optional of ['url', 'episode_guid', 'guid', 'app_version', 'speed', 'sender_id']) {
    if (byteLength(json) <= MAX_BOOSTAGRAM_BYTES) break;
    delete payload[optional];
    json = JSON.stringify(payload);
  }
  while (byteLength(json) > MAX_BOOSTAGRAM_BYTES && typeof payload['message'] === 'string' && payload['message'].length > 1) {
    payload['message'] = clip(payload['message'], Math.floor(payload['message'].length * 0.8));
    json = JSON.stringify(payload);
  }
  return json;
}

/** TLV records for one keysend payment: boostagram (optional) plus the recipient's custom key/value. */
export function customRecordsFor(recipient: ValueRecipient, boostagramJson?: string): Record<string, string> {
  const records: Record<string, string> = {};
  if (boostagramJson) records[String(BOOSTAGRAM_TLV)] = boostagramJson;
  if (recipient.customKey && recipient.customValue) records[recipient.customKey] = recipient.customValue;
  return records;
}

export function utf8ToHex(s: string): string {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A value block we know how to pay: lightning/keysend with at least one usable recipient. */
export function isPayableValue(v: ValueBlock | undefined): v is ValueBlock {
  if (!v) return false;
  if (v.type.toLowerCase() !== 'lightning') return false;
  return v.recipients.some((r) => r.address && r.split > 0 && (r.type === 'node' || r.type === 'lnaddress'));
}
