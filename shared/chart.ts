/** "Nice" axis ticks (1, 2, 5 × 10^n steps) covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rough = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual >= 7.5 ? 10 : residual >= 3.5 ? 5 : residual >= 1.5 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  // Integer multiples of the step, trimmed to 12 significant digits: 3 * 0.1 must read as 0.3, not 0.30000000000000004.
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
}

/** Evenly pick at most `max` points, always keeping the first and the last. */
export function downsample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max || max < 2) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!);
  return out;
}

/** Index of the point whose x is closest to `x` (points sorted ascending by x). */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1]! - x) <= Math.abs(xs[lo]! - x)) return lo - 1;
  return lo;
}

/** Pad a [min, max] value range by a fraction so the line does not touch the plot edges. */
export function paddedDomain(min: number, max: number, fraction = 0.06): [number, number] {
  if (min === max) return [min * 0.99, max * 1.01];
  const pad = (max - min) * fraction;
  return [min - pad, max + pad];
}
