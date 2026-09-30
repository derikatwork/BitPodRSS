import { useMemo, useState } from 'react';
import { BTC_PERIODS, computeChanges, formatPct, formatPrice } from '../../../shared/btc';
import { downsample } from '../../../shared/chart';
import type { BtcPeriod, BtcPeriodChange } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import { timeAgo } from '../../lib/format';
import { useSettings } from '../../state/settings';
import { PriceChart } from './PriceChart';
import { useBtc } from './useBtc';

const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'chf', 'jpy'];
const LABELS: Record<BtcPeriod, { tile: string; chart: string; since: string }> = {
  '1W': { tile: '1 week', chart: 'the last week', since: 'a week ago' },
  '1M': { tile: '1 month', chart: 'the last month', since: 'a month ago' },
  '1Y': { tile: '1 year', chart: 'the last year', since: 'a year ago' },
  YTD: { tile: 'Year to date', chart: 'this year so far', since: 'Jan 1' },
};

/** De-emphasised 12-point sparkline; the selected period's is drawn in the accent colour. */
function Sparkline({ series, active }: { series: readonly (readonly [number, number])[]; active: boolean }) {
  const pts = downsample(series, 12);
  const min = Math.min(...pts.map((p) => p[1]));
  const max = Math.max(...pts.map((p) => p[1]));
  const w = 100;
  const h = 28;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 3 - ((p[1] - min) / (max - min || 1)) * (h - 6)).toFixed(1)}`).join('');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={active ? 'var(--accent)' : 'var(--muted)'} strokeOpacity={active ? 1 : 0.7} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Tile({ change, currency, selected, onSelect }: { change: BtcPeriodChange; currency: string; selected: boolean; onSelect: () => void }) {
  const up = change.pct > 0;
  const down = change.pct < 0;
  const cls = up ? 'up' : down ? 'down' : '';
  const signedAbs = `${change.change >= 0 ? '+' : '−'}${formatPrice(Math.abs(change.change), currency, true)}`;
  return (
    <button className="tile" aria-pressed={selected} onClick={onSelect} aria-label={`${LABELS[change.period].tile}: ${formatPct(change.pct)}, ${signedAbs} since ${LABELS[change.period].since}`}>
      <span className="label">{LABELS[change.period].tile}</span>
      <span className={`value delta ${cls}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {(up || down) && <Icon name={up ? 'trend-up' : 'trend-down'} size={18} />}
        {formatPct(change.pct)}
      </span>
      <span className="tiny muted">
        {signedAbs} since {LABELS[change.period].since}
      </span>
      <Sparkline series={change.series} active={selected} />
    </button>
  );
}

/** Current Bitcoin price with its 1-week, 1-month, 1-year and year-to-date change. */
export function PriceCard() {
  const currency = useSettings((s) => s.currency);
  const setSettings = useSettings((s) => s.set);
  const { data, loading, error, reload } = useBtc(currency);
  const [period, setPeriod] = useState<BtcPeriod>('1M');

  const changes = useMemo(() => (data ? computeChanges(data) : undefined), [data]);
  const selected = changes?.[period];

  return (
    <section className="card stack" aria-labelledby="btc-heading" style={{ gap: 16 }}>
      <div className="row wrap">
        <h2 id="btc-heading" className="grow" style={{ fontSize: 15, color: 'var(--ink-2)', fontWeight: 600 }}>
          Bitcoin price
        </h2>
        <select className="select" style={{ width: 'auto' }} value={currency} onChange={(e) => setSettings({ currency: e.target.value })} aria-label="Currency">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </select>
        <button className="btn icon" onClick={reload} disabled={loading} aria-label="Refresh price" title="Refresh price">
          <Icon name="refresh" />
        </button>
      </div>

      {error && (
        <div className="notice error">
          {error} {data ? 'Showing the last price we have.' : ''}
        </div>
      )}

      {data && changes ? (
        <>
          <div>
            <div className="btc-hero" aria-live="polite">
              {formatPrice(data.current, data.currency)}
            </div>
            <div className="small muted">
              Updated {timeAgo(data.asOf)} · {data.source === 'coingecko' ? 'CoinGecko' : 'Coinbase'}
              {data.stale ? ' · showing older data because the price service could not be reached' : ''}
            </div>
          </div>

          <div className="tiles" role="group" aria-label="Choose a period">
            {BTC_PERIODS.map((p) => (
              <Tile key={p} change={changes[p]} currency={data.currency} selected={p === period} onSelect={() => setPeriod(p)} />
            ))}
          </div>

          <PriceChart points={selected!.series} currency={data.currency} period={period} label={`Bitcoin price over ${LABELS[period].chart}`} loading={loading} />
        </>
      ) : (
        !error && <div className="muted">Loading price…</div>
      )}
    </section>
  );
}
