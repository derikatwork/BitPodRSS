import type { BtcHistory } from '../shared/types';
import { HttpError, safeFetch } from './security';

export type JsonFetcher = (url: string) => Promise<unknown>;

export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'chf', 'jpy'] as const;

const TTL_MS = 5 * 60_000;
const STALE_OK_MS = 6 * 3600_000;
const DAY = 86_400_000;

const defaultFetchJson: JsonFetcher = async (url) => {
  const res = await safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, headers: { accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return JSON.parse(res.body.toString('utf8'));
};

type Point = [number, number];

function cleanSeries(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  const points = raw
    .filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
    .map((p): Point => [Number(p[0]), Number(p[1])])
    .sort((a, b) => a[0] - b[0]);
  // Drop exact-timestamp duplicates.
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1]![0]);
}

function assemble(currency: string, source: string, hourly: Point[], daily: Point[]): BtcHistory {
  if (hourly.length < 2 || daily.length < 2) throw new Error(`${source} returned too little price history`);
  const last = hourly[hourly.length - 1]!;
  return { currency, current: last[1], asOf: last[0], source, hourly, daily };
}

// CoinGecko's public API limits history to 365 days and picks the granularity itself:
// hourly for 2-90 days, daily beyond that. Two calls cover everything the chart needs.
async function fromCoinGecko(currency: string, fetchJson: JsonFetcher): Promise<BtcHistory> {
  const base = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart';
  const [hourlyRaw, dailyRaw] = (await Promise.all([
    fetchJson(`${base}?vs_currency=${currency}&days=35`),
    fetchJson(`${base}?vs_currency=${currency}&days=365&interval=daily`),
  ])) as { prices?: unknown }[];
  return assemble(currency, 'coingecko', cleanSeries(hourlyRaw?.prices), cleanSeries(dailyRaw?.prices));
}

/** Coinbase Exchange returns [time(s), low, high, open, close, volume] newest-first, max 300 per call. */
async function candles(pair: string, granularity: 3600 | 86400, from: number, to: number, fetchJson: JsonFetcher): Promise<Point[]> {
  const step = 300 * granularity * 1000;
  const out: Point[] = [];
  for (let end = to; end > from; end -= step) {
    const start = Math.max(from, end - step);
    const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const rows = (await fetchJson(url)) as number[][];
    if (!Array.isArray(rows)) throw new Error('Unexpected Coinbase response');
    for (const r of rows) out.push([r[0]! * 1000, r[4]!]);
  }
  return cleanSeries(out);
}

async function fromCoinbase(currency: string, fetchJson: JsonFetcher, now: number): Promise<BtcHistory> {
  const pair = `BTC-${currency.toUpperCase()}`;
  const [hourly, daily, ticker] = await Promise.all([
    candles(pair, 3600, now - 35 * DAY, now, fetchJson),
    candles(pair, 86400, now - 366 * DAY, now, fetchJson),
    fetchJson(`https://api.exchange.coinbase.com/products/${pair}/ticker`) as Promise<{ price?: string; time?: string }>,
  ]);
  const price = Number.parseFloat(ticker?.price ?? '');
  const at = Date.parse(ticker?.time ?? '');
  if (Number.isFinite(price) && price > 0) {
    const t = Number.isFinite(at) ? at : now;
    if (t > hourly[hourly.length - 1]![0]) hourly.push([t, price]);
  }
  return assemble(currency, 'coinbase', hourly, daily);
}

interface Entry {
  at: number;
  data: BtcHistory;
}

export interface BtcServiceOptions {
  fetchJson?: JsonFetcher;
  now?: () => number;
}

/** Fetches and caches Bitcoin price history, falling back between providers and to stale data. */
export class BtcService {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<BtcHistory>>();
  private fetchJson: JsonFetcher;
  private now: () => number;

  constructor(opts: BtcServiceOptions = {}) {
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.now = opts.now ?? Date.now;
  }

  async get(currencyInput: string): Promise<BtcHistory & { stale?: boolean }> {
    const currency = currencyInput.toLowerCase();
    if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
      throw new HttpError(400, `Unsupported currency. Choose one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
    const cached = this.cache.get(currency);
    if (cached && this.now() - cached.at < TTL_MS) return cached.data;

    let pending = this.inflight.get(currency);
    if (!pending) {
      pending = this.refresh(currency).finally(() => this.inflight.delete(currency));
      this.inflight.set(currency, pending);
    }
    try {
      return await pending;
    } catch (err) {
      if (cached && this.now() - cached.at < STALE_OK_MS) return { ...cached.data, stale: true };
      throw new HttpError(502, `Could not load Bitcoin prices: ${(err as Error).message}`);
    }
  }

  private async refresh(currency: string): Promise<BtcHistory> {
    const errors: string[] = [];
    for (const provider of [
      () => fromCoinGecko(currency, this.fetchJson),
      () => fromCoinbase(currency, this.fetchJson, this.now()),
    ]) {
      try {
        const data = await provider();
        this.cache.set(currency, { at: this.now(), data });
        return data;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    throw new Error(errors.join('; '));
  }
}
