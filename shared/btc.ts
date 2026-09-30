import type { BtcHistory, BtcPeriod, BtcPeriodChange } from './types';

export const BTC_PERIODS: readonly BtcPeriod[] = ['1W', '1M', '1Y', 'YTD'];

type Series = readonly (readonly [number, number])[];

/** The instant each period starts, relative to `now` (all UTC). */
export function periodStart(period: BtcPeriod, now: number): number {
  const d = new Date(now);
  switch (period) {
    case '1W':
      return now - 7 * 86_400_000;
    case '1M': {
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() - 1;
      // Clamp so e.g. Mar 31 -> Feb 28 instead of rolling into March.
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes());
    }
    case '1Y': {
      const lastDay = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth() + 1, 0)).getUTCDate();
      return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes());
    }
    case 'YTD':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

/** Price of the sample closest in time to `t` (series must be sorted ascending). */
export function priceNear(series: Series, t: number): number | undefined {
  if (!series.length) return undefined;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]![0] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = series[lo]!;
  const before = series[lo - 1];
  if (!before) return after[1];
  return Math.abs(before[0] - t) <= Math.abs(after[0] - t) ? before[1] : after[1];
}

function pickSeries(data: BtcHistory, period: BtcPeriod, from: number): Series {
  // Hourly data only reaches back ~a month, so use it for short periods when it covers the whole range.
  const hourly = data.hourly;
  const useHourly = (period === '1W' || period === '1M') && hourly.length > 1 && hourly[0]![0] <= from + 3 * 3_600_000;
  return useHourly ? hourly : data.daily;
}

/** Compute the change over each period ending at the current price. */
export function computeChanges(data: BtcHistory, now: number = data.asOf): Record<BtcPeriod, BtcPeriodChange> {
  const result = {} as Record<BtcPeriod, BtcPeriodChange>;
  for (const period of BTC_PERIODS) {
    const start = periodStart(period, now);
    const series = pickSeries(data, period, start);
    const from = priceNear(series, start) ?? data.current;
    const points = series.filter(([t]) => t >= start && t < data.asOf).map(([t, p]) => [t, p] as [number, number]);
    // Anchor the chart to the exact starting price and the live price.
    const chart: [number, number][] = [[start, from], ...points.filter(([t]) => t > start), [data.asOf, data.current]];
    result[period] = {
      period,
      from,
      change: data.current - from,
      pct: from > 0 ? ((data.current - from) / from) * 100 : 0,
      series: chart,
    };
  }
  return result;
}

export function formatPrice(value: number, currency: string, compact = false): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: compact ? 0 : value < 100 ? 2 : 0,
    }).format(value);
  } catch {
    return `${value.toFixed(0)} ${currency.toUpperCase()}`;
  }
}

export function formatPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}
