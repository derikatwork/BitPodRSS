const RTF = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' }) : undefined;

/** "5 min. ago", "yesterday", or a short date for anything older than a month. */
export function timeAgo(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['week', 7 * 86_400_000],
  ];
  if (abs < 60_000) return 'just now';
  if (abs < 30 * 86_400_000 && RTF) {
    let chosen = units[0]!;
    for (const u of units) if (abs >= u[1]) chosen = u;
    return RTF.format(Math.round(diff / chosen[1]), chosen[0]);
  }
  return new Date(ts).toLocaleDateString(undefined, { year: abs > 300 * 86_400_000 ? 'numeric' : undefined, month: 'short', day: 'numeric' });
}

export function formatDuration(totalSeconds: number | undefined): string {
  if (!totalSeconds || totalSeconds < 0) return '';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${Math.max(1, m)} min`;
}

export function formatSats(sats: number): string {
  return `${Math.round(sats).toLocaleString()} sat${Math.round(sats) === 1 ? '' : 's'}`;
}

export function truncateMiddle(s: string, keep = 10): string {
  return s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`;
}
