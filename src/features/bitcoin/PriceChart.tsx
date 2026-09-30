import { useEffect, useMemo, useRef, useState } from 'react';
import { downsample, nearestIndex, niceTicks, paddedDomain } from '../../../shared/chart';
import { formatPct, formatPrice } from '../../../shared/btc';
import type { BtcPeriod } from '../../../shared/types';

interface Props {
  points: readonly (readonly [number, number])[];
  currency: string;
  period: BtcPeriod;
  /** Shown as the accessible name, e.g. "Bitcoin price, last month". */
  label: string;
  loading?: boolean;
  height?: number;
}

const M = { top: 14, right: 16, bottom: 26, left: 62 };

function formatDate(t: number, period: BtcPeriod, long = false): string {
  const d = new Date(t);
  if (long) return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: period === '1Y' ? 'numeric' : undefined, hour: period === '1W' || period === '1M' ? '2-digit' : undefined, minute: period === '1W' || period === '1M' ? '2-digit' : undefined });
  if (period === '1Y') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  if (period === 'YTD') return d.toLocaleDateString(undefined, { month: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Single-series price chart: 2px line, 10% area wash, hairline grid, end marker with a surface ring.
 * A crosshair snaps to the nearest point on hover or with the arrow keys; every value is also in the table view.
 */
export function PriceChart({ points, currency, period, label, loading, height = 280 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [y0, y1] = paddedDomain(Math.min(...ys), Math.max(...ys));
    const plotW = width - M.left - M.right;
    const plotH = height - M.top - M.bottom;
    const x = (t: number) => M.left + ((t - xs[0]!) / (xs[xs.length - 1]! - xs[0]!)) * plotW;
    const y = (v: number) => M.top + (1 - (v - y0) / (y1 - y0)) * plotH;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const bottom = M.top + plotH;
    const area = `${line}L${x(xs[xs.length - 1]!).toFixed(1)},${bottom}L${x(xs[0]!).toFixed(1)},${bottom}Z`;
    const yTicks = niceTicks(y0, y1, 4);
    const xTicks = Array.from({ length: 5 }, (_, i) => xs[0]! + ((xs[xs.length - 1]! - xs[0]!) * i) / 4);
    return { xs, x, y, line, area, yTicks, xTicks, plotW, plotH, bottom };
  }, [points, width, height]);

  if (!geo) return <div className="muted small" style={{ height }}>Not enough data to draw a chart.</div>;

  const last = points.length - 1;
  const active = hover ?? null;
  const at = active !== null ? points[active]! : null;
  const first = points[0]![1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = geo.xs[0]! + ((px - M.left) / geo.plotW) * (geo.xs[geo.xs.length - 1]! - geo.xs[0]!);
    setHover(nearestIndex(geo.xs, t));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const from = active ?? last;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, from - step);
    else if (e.key === 'ArrowRight') next = Math.min(last, from + step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') next = null;
    else return;
    e.preventDefault();
    setHover(next);
  };

  const tipLeft = at ? Math.min(Math.max(geo.x(at[0]) - 60, 4), width - 150) : 0;
  const tableRows = downsample(points, 24);

  return (
    <div>
      <div ref={wrapRef} className={`chart-wrap${loading ? ' loading' : ''}`} style={{ height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-label={`${label}. ${formatPrice(first, currency)} to ${formatPrice(points[last]![1], currency)}. Use arrow keys to read values, or open the table.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onFocus={() => setHover((h) => h ?? last)}
          onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y', outlineOffset: 0 }}
        >
          {/* hairline solid grid, recessive */}
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 8} y={geo.y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatPrice(v, currency, true)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={width - M.right} y1={geo.bottom} y2={geo.bottom} stroke="var(--axis)" strokeWidth={1} />
          {geo.xTicks.map((t, i) => (
            <text key={i} x={geo.x(t)} y={geo.bottom + 17} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize={11} fill="var(--muted)">
              {formatDate(t, period)}
            </text>
          ))}

          <path d={geo.area} fill="var(--accent)" opacity={0.1} />
          <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* end marker: >= 8px with a 2px ring in the surface colour */}
          {active === null && <circle cx={geo.x(points[last]![0])} cy={geo.y(points[last]![1])} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />}

          {at && (
            <g pointerEvents="none">
              <line x1={geo.x(at[0])} x2={geo.x(at[0])} y1={M.top} y2={geo.bottom} stroke="var(--axis)" strokeWidth={1} />
              <circle cx={geo.x(at[0])} cy={geo.y(at[1])} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {at && (
          <div className="chart-tip" role="status" style={{ left: tipLeft, top: 0 }}>
            <strong>{formatPrice(at[1], currency)}</strong>
            <span className="row" style={{ gap: 6 }}>
              <span aria-hidden="true" style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--accent)', borderRadius: 1 }} />
              <span className="secondary">{formatDate(at[0], period, true)}</span>
            </span>
            <span className="muted">{formatPct(((at[1] - first) / first) * 100)} vs start</span>
          </div>
        )}
      </div>

      <div className="row small" style={{ marginTop: 6 }}>
        <button className="btn ghost" aria-expanded={showTable} onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Hide table' : 'View as table'}
        </button>
      </div>
      {showTable && (
        <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 4 }}>
          <table className="data-table">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="num">Price</th>
                <th scope="col" className="num">Change vs start</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map(([t, v]) => (
                <tr key={t}>
                  <td>{formatDate(t, period, true)}</td>
                  <td className="num">{formatPrice(v, currency)}</td>
                  <td className="num">{formatPct(((v - first) / first) * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
