const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'mkt_tok', 'ref_src', 'ref_url', 'cmpid',
  '_hsenc', '_hsmi', 'hsctatracking', 'vero_id', 'wt.mc_id', 'oly_enc_id', 'oly_anon_id', 'outputtype',
]);

/**
 * Canonical form of an article URL for equality checks: lowercased host without `www.`/`m.`/`amp.`,
 * https, no fragment, no tracking parameters, sorted query, no trailing slash / index file / AMP marker.
 * Returns undefined for anything that is not an http(s) URL.
 */
export function normalizeUrl(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;

  const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()))
    .filter(([k, v]) => !(k.toLowerCase() === 'amp' && (v === '' || v === '1' || v === 'true')))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';

  let path = u.pathname
    .replace(/\/amp\/?$/i, '/')
    .replace(/\.amp(\.html)?$/i, '$1')
    .replace(/\/index\.(html?|php|aspx?)$/i, '/')
    .replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';

  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  return `${host}${port}${path}${query}`;
}

/** Hostname without a leading `www.`, for display. */
export function displayHost(input: string | undefined): string {
  if (!input) return '';
  try {
    return new URL(input).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Resolve a possibly-relative URL against a base; returns undefined when it is not http(s). */
export function absoluteUrl(href: string | undefined, base?: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
