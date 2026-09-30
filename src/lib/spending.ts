import type { LedgerEntry } from '../db';

export interface V4vSettings {
  /** Automatically stream sats while a value-enabled episode plays. Off until the user opts in. */
  streaming: boolean;
  satsPerMinute: number;
  /** Streaming never spends more than this per local calendar day. */
  dailyCapSats: number;
  /** Amount pre-filled in the boost dialog. */
  boostSats: number;
  /** Payments of at least this many sats need a second confirmation. */
  confirmAboveSats: number;
}

export const DEFAULT_V4V: V4vSettings = {
  streaming: false,
  satsPerMinute: 10,
  dailyCapSats: 1000,
  boostSats: 500,
  confirmAboveSats: 1000,
};

type Spend = Pick<LedgerEntry, 'ts' | 'sats' | 'ok' | 'kind'>;

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Sats successfully sent since `since`, optionally only of the given kinds. */
export function spentSince(entries: readonly Spend[], since: number, kinds?: readonly Spend['kind'][]): number {
  return entries.filter((e) => e.ok === 1 && e.ts >= since && (!kinds || kinds.includes(e.kind))).reduce((sum, e) => sum + e.sats, 0);
}

/** Sats streaming may still spend today. Boosts are deliberate, one-off actions and do not count against the cap. */
export function streamingAllowanceToday(entries: readonly Spend[], settings: Pick<V4vSettings, 'dailyCapSats'>, now: number): number {
  return Math.max(0, settings.dailyCapSats - spentSince(entries, startOfLocalDay(now), ['stream']));
}

/** How much to stream for the next minute of listening (0 when the cap is reached or streaming is off). */
export function nextStreamAmount(entries: readonly Spend[], settings: V4vSettings, now: number): number {
  if (!settings.streaming || settings.satsPerMinute < 1) return 0;
  return Math.floor(Math.min(settings.satsPerMinute, streamingAllowanceToday(entries, settings, now)));
}

export function needsConfirmation(sats: number, settings: Pick<V4vSettings, 'confirmAboveSats'>): boolean {
  return sats >= settings.confirmAboveSats;
}

/** Parse a user-typed sats amount; returns undefined unless it is a positive whole number within `max`. */
export function parseSats(input: string, max = 21_000_000 * 1e8): number | undefined {
  const n = Number(input.trim().replace(/[,_\s]/g, ''));
  return Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
}
