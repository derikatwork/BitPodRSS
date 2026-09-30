import { describe, expect, it } from 'vitest';
import { DEFAULT_V4V, needsConfirmation, nextStreamAmount, parseSats, spentSince, startOfLocalDay, streamingAllowanceToday } from './spending';

const NOW = new Date(2026, 5, 15, 14, 30).getTime();
const today = new Date(2026, 5, 15, 9, 0).getTime();
const yesterday = new Date(2026, 5, 14, 23, 59).getTime();
const e = (ts: number, sats: number, kind: 'stream' | 'boost' = 'stream', ok: 0 | 1 = 1) => ({ ts, sats, kind, ok });

describe('spending limits', () => {
  it('counts only successful payments since local midnight', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 5, 15).getTime());
    expect(spentSince([e(today, 100), e(today, 50, 'stream', 0), e(yesterday, 999)], startOfLocalDay(NOW))).toBe(100);
  });

  it('streaming allowance ignores boosts and resets each day', () => {
    const entries = [e(today, 400), e(today, 5000, 'boost'), e(yesterday, 900)];
    expect(streamingAllowanceToday(entries, { dailyCapSats: 1000 }, NOW)).toBe(600);
    expect(streamingAllowanceToday([e(today, 2000)], { dailyCapSats: 1000 }, NOW)).toBe(0);
  });

  it('streams nothing unless enabled, and never more than the remaining cap', () => {
    const on = { ...DEFAULT_V4V, streaming: true, satsPerMinute: 10, dailyCapSats: 100 };
    expect(nextStreamAmount([], DEFAULT_V4V, NOW)).toBe(0);
    expect(nextStreamAmount([], on, NOW)).toBe(10);
    expect(nextStreamAmount([e(today, 95)], on, NOW)).toBe(5);
    expect(nextStreamAmount([e(today, 100)], on, NOW)).toBe(0);
    expect(nextStreamAmount([], { ...on, satsPerMinute: 0 }, NOW)).toBe(0);
  });

  it('requires confirmation at or above the threshold', () => {
    expect(needsConfirmation(999, { confirmAboveSats: 1000 })).toBe(false);
    expect(needsConfirmation(1000, { confirmAboveSats: 1000 })).toBe(true);
  });

  it('parses sat amounts strictly', () => {
    expect(parseSats('1,000')).toBe(1000);
    expect(parseSats(' 21 ')).toBe(21);
    for (const bad of ['', '0', '-5', '1.5', 'abc', '1e3x', '99999999999999999']) expect(parseSats(bad), bad).toBeUndefined();
  });

  it('ships with streaming off', () => {
    expect(DEFAULT_V4V.streaming).toBe(false);
  });
});
