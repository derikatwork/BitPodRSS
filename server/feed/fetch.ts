import type { FeedNotModified, ParsedFeed } from '../../shared/types';
import { absoluteUrl } from '../../shared/url';
import { decodeBody } from '../charset';
import { HttpError, safeFetch } from '../security';
import { parseFeed } from './parse';

const ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5';
const MAX_FEED_BYTES = 25 * 1024 * 1024;

export interface FetchFeedOptions {
  etag?: string;
  lastModified?: string;
  /** Newest items to keep. Default 300. */
  limit?: number;
}

/** Find `<link rel="alternate" type="application/rss+xml" href=...>` style feed links in an HTML page. */
export function discoverFeedLinks(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const tag of html.slice(0, 200_000).matchAll(/<link\b[^>]*>/gi)) {
    const t = tag[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(t)) continue;
    if (!/\btype\s*=\s*["']?application\/(rss\+xml|atom\+xml|feed\+json|rdf\+xml)/i.test(t)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(t);
    const abs = absoluteUrl(href?.[1] ?? href?.[2] ?? href?.[3], pageUrl);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * Fetch and parse a feed. If the URL turns out to be a web page that advertises a feed, that feed is
 * used instead, so users can paste a site address.
 */
export async function fetchFeed(url: string, opts: FetchFeedOptions = {}, depth = 0): Promise<ParsedFeed | FeedNotModified> {
  const headers: Record<string, string> = { accept: ACCEPT };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

  const res = await safeFetch(url, { maxBytes: MAX_FEED_BYTES, headers, timeoutMs: 30_000 });
  if (res.status === 304) return { notModified: true };
  if (res.status >= 400) throw new HttpError(502, `The feed server answered HTTP ${res.status}`);

  const text = decodeBody(res.body, res.headers.get('content-type') ?? '');
  try {
    const feed = parseFeed(text, { url: res.url, limit: opts.limit });
    feed.etag = res.headers.get('etag') ?? undefined;
    feed.lastModified = res.headers.get('last-modified') ?? undefined;
    return feed;
  } catch (err) {
    if (depth === 0 && /<html[\s>]/i.test(text.slice(0, 2048))) {
      const [alternate] = discoverFeedLinks(text, res.url);
      if (alternate) return fetchFeed(alternate, { limit: opts.limit }, depth + 1);
      throw new HttpError(422, 'That page does not advertise an RSS or Atom feed. Try the feed URL itself.');
    }
    throw new HttpError(422, (err as Error).message);
  }
}
