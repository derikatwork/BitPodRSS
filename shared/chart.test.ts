import { describe, expect, it } from 'vitest';
import { downsample, nearestIndex, niceTicks, paddedDomain } from './chart';

describe('niceTicks', () => {
  it('produces round numbers that stay within the range', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(61_234, 98_765, 4)).toEqual([70_000, 80_000, 90_000]);
    expect(niceTicks(0.12, 0.47, 3)).toEqual([0.2, 0.3, 0.4]);
  });
  it('is free of floating point noise', () => {
    for (const t of niceTicks(0, 1, 10)) expect(String(t).length).toBeLessThan(6);
  });
  it('handles degenerate and invalid input', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 5)).toEqual([]);
  });
});

describe('downsample', () => {
  it('keeps first and last and spreads the rest evenly', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = downsample(items, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(99);
    expect(out).toEqual([...out].sort((a, b) => a - b));
  });
  it('returns everything when already small', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe('nearestIndex', () => {
  it('snaps to the closest x', () => {
    const xs = [0, 10, 20, 40];
    expect(nearestIndex(xs, 4)).toBe(0);
    expect(nearestIndex(xs, 6)).toBe(1);
    expect(nearestIndex(xs, 31)).toBe(3);
    expect(nearestIndex(xs, -50)).toBe(0);
    expect(nearestIndex(xs, 999)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe('paddedDomain', () => {
  it('adds headroom and copes with a flat series', () => {
    const [lo, hi] = paddedDomain(100, 200);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(200);
    const [a, b] = paddedDomain(50, 50);
    expect(a).toBeLessThan(b);
  });
});
