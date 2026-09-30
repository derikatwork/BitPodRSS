import { describe, expect, it } from 'vitest';
import { StreamMeter } from './streaming';

/** Simulate listening: `timeupdate` roughly every 250 ms of media time. */
function listen(meter: StreamMeter, from: number, seconds: number, playing = true): number {
  let units = 0;
  for (let t = from; t <= from + seconds + 1e-9; t += 0.25) units += meter.tick(t, playing);
  return units;
}

describe('StreamMeter', () => {
  it('counts one unit per minute of continuous listening', () => {
    const m = new StreamMeter();
    expect(listen(m, 0, 59)).toBe(0);
    expect(listen(m, 59.25, 1)).toBe(1);
    expect(listen(m, 60.5, 120)).toBe(2);
  });

  it('does not count time while paused', () => {
    const m = new StreamMeter();
    listen(m, 0, 30);
    expect(listen(m, 30.25, 600, false)).toBe(0);
    expect(m.pendingSeconds).toBeCloseTo(30, 0);
  });

  it('does not count seeks or skips as listening', () => {
    const m = new StreamMeter();
    listen(m, 0, 10);
    expect(m.tick(1800, true)).toBe(0); // jump forward 30 minutes
    expect(m.tick(5, true)).toBe(0); // jump back
    expect(m.pendingSeconds).toBeLessThan(11);
  });

  it('keeps the remainder across units and can be reset', () => {
    const m = new StreamMeter();
    expect(listen(m, 0, 90)).toBe(1);
    expect(m.pendingSeconds).toBeCloseTo(30, 0);
    m.reset();
    expect(m.pendingSeconds).toBe(0);
    expect(m.tick(500, true)).toBe(0); // first tick after reset only establishes the position
  });

  it('ignores a repeated position', () => {
    const m = new StreamMeter();
    m.tick(10, true);
    for (let i = 0; i < 1000; i++) expect(m.tick(10, true)).toBe(0);
    expect(m.pendingSeconds).toBe(0);
  });
});
