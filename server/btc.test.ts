import { describe, expect, it, vi } from 'vitest';
import { BtcService, type JsonFetcher } from './btc';

const NOW = Date.UTC(2026, 8, 30, 12);
const DAY = 86_400_000;

function geckoFetcher(): JsonFetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const days = Number(new URL(url).searchParams.get('days'));
    const step = days > 90 ? DAY : 3_600_000;
    const prices: [number, number][] = [];
    for (let t = NOW - days * DAY; t <= NOW; t += step) prices.push([t, 60_000 + (t - (NOW - days * DAY)) / DAY]);
    return { prices };
  });
}

describe('BtcService (CoinGecko)', () => {
  it('builds hourly + daily series and uses the latest point as the current price', async () => {
    const fetchJson = geckoFetcher();
    const svc = new BtcService({ fetchJson, now: () => NOW });
    const d = await svc.get('USD');
    expect(d.source).toBe('coingecko');
    expect(d.currency).toBe('usd');
    expect(d.asOf).toBe(NOW);
    expect(d.current).toBe(d.hourly[d.hourly.length - 1]![1]);
    expect(d.hourly.length).toBeGreaterThan(800);
    expect(d.daily.length).toBeGreaterThan(300);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(String(fetchJson.mock.calls[0]![0])).toContain('vs_currency=usd');
  });

  it('serves repeat requests from cache within the TTL and refreshes afterwards', async () => {
    const fetchJson = geckoFetcher();
    let now = NOW;
    const svc = new BtcService({ fetchJson, now: () => now });
    await svc.get('usd');
    await svc.get('usd');
    expect(fetchJson).toHaveBeenCalledTimes(2);
    now += 6 * 60_000;
    await svc.get('usd');
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it('shares one upstream request between concurrent callers', async () => {
    const fetchJson = geckoFetcher();
    const svc = new BtcService({ fetchJson, now: () => NOW });
    await Promise.all([svc.get('eur'), svc.get('eur'), svc.get('eur')]);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported currencies before touching the network', async () => {
    const fetchJson = geckoFetcher();
    const svc = new BtcService({ fetchJson });
    await expect(svc.get('xyz')).rejects.toMatchObject({ status: 400 });
    await expect(svc.get('usd&days=1')).rejects.toMatchObject({ status: 400 });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('ignores malformed points', async () => {
    const svc = new BtcService({
      now: () => NOW,
      fetchJson: async () => ({ prices: [[NOW - 2 * DAY, 1], 'junk', [NOW - DAY, null], [NOW - DAY, 2], [NOW - DAY, 2], [NOW, -5], [NOW, 3]] }),
    });
    const d = await svc.get('usd');
    expect(d.daily).toEqual([[NOW - 2 * DAY, 1], [NOW - DAY, 2], [NOW, 3]]);
  });
});

describe('BtcService (fallback)', () => {
  const coinbase: JsonFetcher = vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.hostname === 'api.coingecko.com') throw new Error('HTTP 429 from api.coingecko.com');
    if (u.pathname.endsWith('/ticker')) return { price: '61000.5', time: new Date(NOW).toISOString() };
    const g = Number(u.searchParams.get('granularity'));
    const start = Date.parse(u.searchParams.get('start')!);
    const end = Date.parse(u.searchParams.get('end')!);
    const rows: number[][] = [];
    for (let t = end - g * 1000; t >= start; t -= g * 1000) rows.push([t / 1000, 0, 0, 0, 60_000 + t / 1e9, 1]);
    return rows.slice(0, 300);
  });

  it('falls back to Coinbase when CoinGecko fails and pages through candles', async () => {
    const svc = new BtcService({ fetchJson: coinbase, now: () => NOW });
    const d = await svc.get('usd');
    expect(d.source).toBe('coinbase');
    expect(d.current).toBe(61000.5);
    expect(d.hourly.length).toBeGreaterThan(800);
    expect(d.daily.length).toBeGreaterThan(350);
    const ts = d.daily.map((p) => p[0]);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('serves stale data when every provider fails after a success', async () => {
    let fail = false;
    const base = geckoFetcher();
    let now = NOW;
    const svc = new BtcService({
      now: () => now,
      fetchJson: async (u) => {
        if (fail) throw new Error('offline');
        return base(u);
      },
    });
    await svc.get('usd');
    fail = true;
    now += 10 * 60_000;
    const d = await svc.get('usd');
    expect(d.stale).toBe(true);
    now += 7 * 3600_000;
    await expect(svc.get('usd')).rejects.toMatchObject({ status: 502, message: /offline/ });
  });

  it('reports a 502 when no data was ever available', async () => {
    const svc = new BtcService({ fetchJson: async () => { throw new Error('down'); }, now: () => NOW });
    await expect(svc.get('usd')).rejects.toMatchObject({ status: 502 });
  });
});
