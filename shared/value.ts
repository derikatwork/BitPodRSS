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

/** Build the JSON carried in TLV record 7629169. Undefined fields are omitted. */
export function buildBoostagram(b: BoostagramInput): string {
  const payload: Record<string, unknown> = {
    action: b.action,
    app_name: b.appName,
    app_version: b.appVersion,
    podcast: b.podcast,
    url: b.feedUrl,
    guid: b.feedGuid,
    episode: b.episode,
    episode_guid: b.episodeGuid,
    ts: b.ts != null ? Math.floor(b.ts) : undefined,
    name: b.recipientName,
    sender_name: b.senderName,
    sender_id: b.senderNostrPubkey,
    message: b.message,
    value_msat: b.valueMsat,
    value_msat_total: b.valueMsatTotal,
    speed: b.speed != null ? String(b.speed) : undefined,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined || payload[k] === '') delete payload[k];
  return JSON.stringify(payload);
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
