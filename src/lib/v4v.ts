import type { ValueBlock, ValueRecipient } from '../../shared/types';
import { buildBoostagram, computeSplits, customRecordsFor } from '../../shared/value';
import { db } from '../db';
import { payLightningAddress, type WalletProvider } from './wallet';

export const APP_NAME = 'BitPodRSS';
export const APP_VERSION = '0.1.0';

export interface PayValueArgs {
  wallet: WalletProvider;
  value: ValueBlock;
  totalSats: number;
  action: 'boost' | 'stream';
  podcast: { id?: number; title: string; url?: string; guid?: string };
  episode?: { id?: number; title: string; guid?: string };
  /** Playback position in seconds when the payment was made. */
  ts?: number;
  speed?: number;
  message?: string;
  senderName?: string;
  /** Sender's Nostr public key (hex), when an identity is connected. */
  senderPubkey?: string;
}

export interface RecipientResult {
  recipient: ValueRecipient;
  sats: number;
  ok: boolean;
  error?: string;
}

export interface PayValueDeps {
  payAddress?: typeof payLightningAddress;
}

/**
 * Pay a podcast's value block: split `totalSats` between its recipients and send each share by keysend
 * (node recipients, with a boostagram attached) or LNURL-pay (Lightning-address recipients).
 *
 * Payments are sequential so the wallet's budget is checked one at a time, and one failing recipient never
 * stops the others.
 */
export async function payValue(args: PayValueArgs, deps: PayValueDeps = {}): Promise<RecipientResult[]> {
  const payAddress = deps.payAddress ?? payLightningAddress;
  const splits = computeSplits(args.totalSats, args.value.recipients);
  const totalMsat = args.totalSats * 1000;
  const results: RecipientResult[] = [];

  for (const { recipient, sats } of splits) {
    try {
      if (recipient.type === 'node') {
        const boost = buildBoostagram({
          appName: APP_NAME,
          appVersion: APP_VERSION,
          action: args.action,
          podcast: args.podcast.title,
          feedUrl: args.podcast.url,
          feedGuid: args.podcast.guid,
          episode: args.episode?.title,
          episodeGuid: args.episode?.guid,
          ts: args.ts,
          speed: args.speed,
          message: args.message,
          senderName: args.senderName,
          senderNostrPubkey: args.senderPubkey,
          recipientName: recipient.name,
          valueMsat: sats * 1000,
          valueMsatTotal: totalMsat,
        });
        await args.wallet.keysend({ pubkey: recipient.address, sats, records: customRecordsFor(recipient, boost) });
      } else if (recipient.type === 'lnaddress') {
        const comment = [args.senderName && `${args.senderName}:`, args.message].filter(Boolean).join(' ') || undefined;
        await payAddress(args.wallet, recipient.address, sats, { comment });
      } else {
        throw new Error(`Unsupported recipient type "${recipient.type}"`);
      }
      results.push({ recipient, sats, ok: true });
    } catch (err) {
      results.push({ recipient, sats, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export function summarizePayments(results: readonly RecipientResult[]): { paidSats: number; failedSats: number; failures: number } {
  let paidSats = 0;
  let failedSats = 0;
  let failures = 0;
  for (const r of results) {
    if (r.ok) paidSats += r.sats;
    else {
      failedSats += r.sats;
      failures++;
    }
  }
  return { paidSats, failedSats, failures };
}

/** Write one ledger row per recipient. Spending limits and the history view read from this. */
export async function recordPayments(results: readonly RecipientResult[], args: Pick<PayValueArgs, 'action' | 'podcast' | 'episode'>, now = Date.now()): Promise<void> {
  await db.ledger.bulkAdd(
    results.map((r) => ({
      ts: now,
      kind: args.action,
      sats: r.sats,
      ok: r.ok ? (1 as const) : (0 as const),
      podcastId: args.podcast.id,
      episodeId: args.episode?.id,
      recipient: r.recipient.name || r.recipient.address,
      note: args.podcast.title,
      error: r.error,
    })),
  );
}
