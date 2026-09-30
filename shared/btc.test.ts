import { describe, expect, it } from 'vitest';
import { computeChanges, formatPct, periodStart, priceNear } from './btc';
import type { BtcHistory } from './types';

const DAY = 86_400_000;

/** Daily points at 00:00 UTC rising $100/day from 2025-01-01, plus hourly points for the last 35 days. */
function fixture(asOf: number, withHourly = true): BtcHistory {
  const start = Date.UTC(2025, 0, 1);
  const price = (t: number) => 50_000 + ((t - start) / DAY) * 100;
  const daily: [number, number][] = [];
  for (let t = start; t <= asOf; t += DAY) daily.push([t, price(t)]);
  const hourly: [number, number][] = [];
  if (withHourly) for (let t = asOf - 35 * DAY; t <= asOf; t += 3_600_000) hourly.push([t, price(t)]);
  return { currency: 'usd', current: price(asOf), asOf, source: 'test', hourly, daily };
}

describe('periodStart', () => {
  const now = Date.UTC(2026, 8, 30, 12);
  it('computes each period boundary in UTC', () => {
    expect(periodStart('1W', now)).toBe(Date.UTC(2026, 8, 23, 12));
    expect(periodStart('1M', now)).toBe(Date.UTC(2026, 7, 30, 12));
    expect(periodStart('1Y', now)).toBe(Date.UTC(2025, 8, 30, 12));
    expect(periodStart('YTD', now)).toBe(Date.UTC(2026, 0, 1));
  });
  it('clamps month and leap-day overflow', () => {
    expect(periodStart('1M', Date.UTC(2026, 2, 31))).toBe(Date.UTC(2026, 1, 28));
    expect(periodStart('1Y', Date.UTC(2028, 1, 29))).toBe(Date.UTC(2027, 1, 28));
  });
  it('rolls YTD over at the new year', () => {
    expect(periodStart('YTD', Date.UTC(2027, 0, 1, 0, 1))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe('priceNear', () => {
  const s: [number, number][] = [[0, 10], [10, 20], [20, 30]];
  it('picks the closest sample', () => {
    expect(priceNear(s, 4)).toBe(10);
    expect(priceNear(s, 6)).toBe(20);
    expect(priceNear(s, -100)).toBe(10);
    expect(priceNear(s, 100)).toBe(30);
    expect(priceNear([], 1)).toBeUndefined();
  });
});

describe('computeChanges', () => {
  const asOf = Date.UTC(2026, 8, 30, 12);
  const data = fixture(asOf);
  const changes = computeChanges(data);

  it('reports absolute and percentage change from the start price', () => {
    for (const c of Object.values(changes)) {
      expect(c.change).toBeCloseTo(data.current - c.from, 6);
      expect(c.pct).toBeCloseTo(((data.current - c.from) / c.from) * 100, 6);
      expect(c.pct).toBeGreaterThan(0);
    }
  });

  it('YTD starts at the first price of the year', () => {
    const jan1 = data.daily.find(([t]) => t === Date.UTC(2026, 0, 1))![1];
    expect(changes.YTD.from).toBe(jan1);
  });

  it('1W covers ~7 days using hourly data and ends at the live price', () => {
    const c = changes['1W'];
    expect(c.series[0]![0]).toBe(asOf - 7 * DAY);
    expect(c.series[c.series.length - 1]).toEqual([asOf, data.current]);
    expect(c.series.length).toBeGreaterThan(100);
    expect(c.from).toBeCloseTo(data.current - 700, 0);
  });

  it('1Y uses daily data and is roughly a year long', () => {
    const c = changes['1Y'];
    expect(c.series.length).toBeGreaterThan(300);
    expect(c.series.length).toBeLessThan(400);
  });

  it('series are sorted ascending', () => {
    for (const c of Object.values(changes)) {
      const ts = c.series.map(([t]) => t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
  });

  it('falls back to daily data when there is no hourly history', () => {
    const c = computeChanges(fixture(asOf, false))['1W'];
    expect(c.series.length).toBeGreaterThanOrEqual(7);
    expect(c.pct).toBeGreaterThan(0);
  });

  it('handles a falling market', () => {
    const d = fixture(asOf);
    d.current = 1000;
    expect(computeChanges(d).YTD.pct).toBeLessThan(0);
  });
});

describe('formatPct', () => {
  it('adds signs', () => {
    expect(formatPct(12.345)).toBe('+12.35%');
    expect(formatPct(-3)).toBe('−3.00%');
    expect(formatPct(0)).toBe('0.00%');
  });
});
