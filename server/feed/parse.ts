import { XMLParser } from 'fast-xml-parser';
import type {
  AlternateEnclosure,
  ChaptersRef,
  Enclosure,
  FeedKind,
  Funding,
  ParsedFeed,
  ParsedItem,
  Person,
  PodcastChannelMeta,
  PodcastItemMeta,
  Soundbite,
  TranscriptRef,
  ValueBlock,
  ValueRecipient,
} from '../../shared/types';
import { fnv1a } from '../../shared/text';
import { parseTimestamp } from '../../shared/transcript';
import { absoluteUrl } from '../../shared/url';
import { satsFromSuggested } from '../../shared/value';
import { firstImage, htmlToText, looksLikeHtml, summaryFromHtml } from '../html';

// fast-xml-parser yields loosely-typed trees; these helpers keep the access code readable.
/* eslint-disable @typescript-eslint/no-explicit-any */
type X = any;

const ARRAY_TAGS = new Set([
  'item', 'entry', 'category', 'link', 'enclosure', 'author', 'atom:link', 'media:content', 'media:thumbnail',
  'itunes:category', 'podcast:person', 'podcast:transcript', 'podcast:funding', 'podcast:valueRecipient', 'podcast:soundbite',
  'podcast:alternateEnclosure', 'podcast:source', 'podcast:txt', 'podcast:value', 'podcast:trailer', 'podcast:chapters',
]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const MAX_CONTENT_CHARS = 200_000;

// ---------------------------------------------------------------------------------------------
// Namespace prefix normalisation
// ---------------------------------------------------------------------------------------------

const NAMESPACES: [RegExp, string][] = [
  [/^https?:\/\/(podcastindex\.org\/namespace\/1\.0|github\.com\/Podcastindex-org\/podcast-namespace\/blob\/main\/docs\/1\.0\.md)$/i, 'podcast'],
  [/^https?:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd$/i, 'itunes'],
  [/^https?:\/\/purl\.org\/rss\/1\.0\/modules\/content\/?$/i, 'content'],
  [/^https?:\/\/purl\.org\/dc\/elements\/1\.1\/?$/i, 'dc'],
  [/^https?:\/\/search\.yahoo\.com\/mrss\/?$/i, 'media'],
  [/^https?:\/\/www\.w3\.org\/2005\/Atom$/i, 'atom'],
];

/**
 * Any prefix bound to a well-known namespace URI is valid XML, but the parser below keys on the
 * conventional prefixes. Rewrite unconventional ones (e.g. `xmlns:pc="…/namespace/1.0"`) to match.
 */
export function normalizePrefixes(source: string): string {
  const declarations = source.slice(0, 16_384).matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']+)["']/g);
  let out = source;
  for (const [, prefix, uri] of declarations) {
    const canonical = NAMESPACES.find(([re]) => re.test(uri!))?.[1];
    if (canonical && prefix !== canonical) {
      out = out.replaceAll(`<${prefix}:`, `<${canonical}:`).replaceAll(`</${prefix}:`, `</${canonical}:`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small extraction helpers
// ---------------------------------------------------------------------------------------------

const arr = (v: X): X[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Concatenate every string leaf (used for XHTML bodies that the parser turned into objects). */
function deepText(v: X): string {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(deepText).join(' ');
  return Object.entries(v)
    .filter(([k]) => !k.startsWith('@_'))
    .map(([, val]) => deepText(val))
    .join(' ');
}

/** Text of a node that may be a string, an object with `#text`, or an array of either. */
function str(v: X): string {
  if (v == null) return '';
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === 'object') return typeof v['#text'] === 'string' ? v['#text'].trim() : '';
  return String(v).trim();
}

const attr = (node: X, name: string): string | undefined => {
  const v = node && typeof node === 'object' ? node[`@_${name}`] : undefined;
  return v == null || v === '' ? undefined : String(v).trim();
};

function toBool(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (['yes', 'true', 'explicit'].includes(s)) return true;
  if (['no', 'false', 'clean'].includes(s)) return false;
  return undefined;
}

function toInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function parseDate(v: string | undefined): number | undefined {
  if (!v) return undefined;
  let t = Date.parse(v);
  // Some feeds write invalid weekday names ("Tues, 12 Mar 2024"); the date itself is still fine.
  if (Number.isNaN(t)) t = Date.parse(v.replace(/^[A-Za-z]+,\s*/, ''));
  if (Number.isNaN(t)) return undefined;
  return t >= Date.UTC(1990, 0, 1) && t <= Date.UTC(2100, 0, 1) ? t : undefined;
}

function parseDuration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseTimestamp(v.replace(/[^\d:.,]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function isMedia(type: string | undefined, url: string | undefined): boolean {
  if (type) return /^(audio|video)\//i.test(type) || /ogg|mpeg|mp4|x-m4a|x-mp3/i.test(type);
  return !!url && /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm)(\?|#|$)/i.test(url);
}

function firstNonEmpty(...vals: (string | undefined)[]): string {
  return vals.find((v) => v && v.trim()) ?? '';
}

// ---------------------------------------------------------------------------------------------
// Podcasting 2.0 blocks
// ---------------------------------------------------------------------------------------------

function parsePersons(node: X): Person[] {
  return arr(node['podcast:person'])
    .map((p): Person | undefined => {
      const name = str(p);
      if (!name) return undefined;
      return { name, role: attr(p, 'role'), group: attr(p, 'group'), img: attr(p, 'img'), href: attr(p, 'href') };
    })
    .filter((p): p is Person => !!p);
}

function parseFunding(node: X): Funding[] {
  return arr(node['podcast:funding'])
    .map((f): Funding | undefined => {
      const url = absoluteUrl(attr(f, 'url'));
      return url ? { url, text: str(f) || undefined } : undefined;
    })
    .filter((f): f is Funding => !!f);
}

function parseValue(node: X): ValueBlock | undefined {
  const blocks = arr(node['podcast:value']).map((v): ValueBlock => {
    const recipients = arr(v['podcast:valueRecipient']).map((r): ValueRecipient => ({
      name: attr(r, 'name'),
      type: (attr(r, 'type') ?? 'node').toLowerCase(),
      address: attr(r, 'address') ?? '',
      customKey: attr(r, 'customKey'),
      customValue: attr(r, 'customValue'),
      split: Number.parseFloat(attr(r, 'split') ?? '0') || 0,
      fee: attr(r, 'fee')?.toLowerCase() === 'true' ? true : undefined,
    }));
    return {
      type: (attr(v, 'type') ?? 'lightning').toLowerCase(),
      method: (attr(v, 'method') ?? 'keysend').toLowerCase(),
      suggestedSatsPerMinute: satsFromSuggested(attr(v, 'suggested')),
      recipients: recipients.filter((r) => r.address),
    };
  });
  return blocks.find((b) => b.type === 'lightning' && b.method === 'keysend') ?? blocks[0];
}

function parseItunesCategories(node: X): string[] {
  const out: string[] = [];
  const visit = (c: X): void => {
    const text = attr(c, 'text');
    if (text) out.push(htmlToText(text));
    for (const child of arr(c['itunes:category'])) visit(child);
  };
  for (const c of arr(node['itunes:category'])) visit(c);
  return out;
}

function parseChannelPodcast(ch: X): PodcastChannelMeta {
  const locked = arr(ch['podcast:locked'])[0];
  const showType = str(ch['itunes:type']).toLowerCase();
  return {
    author: str(ch['itunes:author']) || undefined,
    ownerName: str(ch['itunes:owner']?.['itunes:name']) || undefined,
    ownerEmail: str(ch['itunes:owner']?.['itunes:email']) || undefined,
    explicit: toBool(str(ch['itunes:explicit'])),
    showType: showType === 'serial' ? 'serial' : showType === 'episodic' ? 'episodic' : undefined,
    itunesCategories: parseItunesCategories(ch),
    copyright: str(ch['copyright']) || undefined,
    newFeedUrl: absoluteUrl(str(ch['itunes:new-feed-url'])),
    guid: str(ch['podcast:guid']) || undefined,
    locked: locked != null ? toBool(str(locked)) : undefined,
    medium: str(ch['podcast:medium']) || undefined,
    funding: parseFunding(ch),
    persons: parsePersons(ch),
    value: parseValue(ch),
    license: str(ch['podcast:license']) || undefined,
    txt: arr(ch['podcast:txt']).map((t) => ({ purpose: attr(t, 'purpose'), text: str(t) })).filter((t) => t.text),
  };
}

function parseItemPodcast(it: X, baseUrl: string): PodcastItemMeta {
  const transcripts: TranscriptRef[] = arr(it['podcast:transcript'])
    .map((t): TranscriptRef | undefined => {
      const url = absoluteUrl(attr(t, 'url'), baseUrl);
      return url ? { url, type: attr(t, 'type') ?? 'text/plain', language: attr(t, 'language'), rel: attr(t, 'rel') } : undefined;
    })
    .filter((t): t is TranscriptRef => !!t);

  const chaptersNode = arr(it['podcast:chapters'])[0];
  const chaptersUrl = absoluteUrl(attr(chaptersNode, 'url'), baseUrl);
  const chapters: ChaptersRef | undefined = chaptersUrl ? { url: chaptersUrl, type: attr(chaptersNode, 'type') ?? 'application/json+chapters' } : undefined;

  const soundbites: Soundbite[] = arr(it['podcast:soundbite'])
    .map((s): Soundbite | undefined => {
      const startTime = Number.parseFloat(attr(s, 'startTime') ?? '');
      const duration = Number.parseFloat(attr(s, 'duration') ?? '');
      return Number.isFinite(startTime) && Number.isFinite(duration) ? { startTime, duration, title: str(s) || undefined } : undefined;
    })
    .filter((s): s is Soundbite => !!s);

  const alternateEnclosures: AlternateEnclosure[] = arr(it['podcast:alternateEnclosure']).map((a) => ({
    type: attr(a, 'type') ?? '',
    length: toInt(attr(a, 'length')),
    bitrate: toInt(attr(a, 'bitrate')),
    title: attr(a, 'title'),
    lang: attr(a, 'lang'),
    default: attr(a, 'default')?.toLowerCase() === 'true' ? true : undefined,
    sources: arr(a['podcast:source'])
      .map((s) => ({ uri: absoluteUrl(attr(s, 'uri'), baseUrl) ?? '', contentType: attr(s, 'contentType') }))
      .filter((s) => s.uri),
  }));

  const episodeNode = arr(it['podcast:episode'])[0];
  const seasonNode = arr(it['podcast:season'])[0];
  const episodeType = str(it['itunes:episodeType']).toLowerCase();

  return {
    duration: parseDuration(str(it['itunes:duration'])),
    episode: toInt(str(it['itunes:episode'])) ?? toInt(str(episodeNode)),
    episodeDisplay: attr(episodeNode, 'display'),
    season: toInt(str(it['itunes:season'])) ?? toInt(str(seasonNode)),
    seasonName: attr(seasonNode, 'name'),
    episodeType: episodeType === 'trailer' || episodeType === 'bonus' || episodeType === 'full' ? episodeType : undefined,
    explicit: toBool(str(it['itunes:explicit'])),
    transcripts,
    chapters,
    persons: parsePersons(it),
    value: parseValue(it),
    soundbites,
    alternateEnclosures,
    funding: parseFunding(it),
    license: str(it['podcast:license']) || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

function pickEnclosure(it: X, baseUrl: string): Enclosure | undefined {
  const candidates: Enclosure[] = [];
  for (const e of arr(it['enclosure'])) {
    const url = absoluteUrl(attr(e, 'url'), baseUrl);
    if (url) candidates.push({ url, type: attr(e, 'type'), length: toInt(attr(e, 'length')) });
  }
  // Atom: <link rel="enclosure" href="..."/>
  for (const l of arr(it['link'])) {
    if (attr(l, 'rel') === 'enclosure') {
      const url = absoluteUrl(attr(l, 'href'), baseUrl);
      if (url) candidates.push({ url, type: attr(l, 'type'), length: toInt(attr(l, 'length')) });
    }
  }
  // Media RSS
  for (const m of arr(it['media:content'])) {
    const url = absoluteUrl(attr(m, 'url'), baseUrl);
    if (url) candidates.push({ url, type: attr(m, 'type'), length: toInt(attr(m, 'fileSize')) });
  }
  return candidates.find((c) => isMedia(c.type, c.url)) ?? candidates[0];
}

function itemImage(it: X, html: string | undefined, baseUrl: string): string | undefined {
  const href = attr(arr(it['itunes:image'])[0], 'href');
  const candidates = [
    href,
    attr(arr(it['media:thumbnail'])[0], 'url'),
    attr(arr(it['media:content']).find((m) => /image/i.test(attr(m, 'medium') ?? attr(m, 'type') ?? '')), 'url'),
    attr(arr(it['enclosure']).find((e) => /^image\//i.test(attr(e, 'type') ?? '')), 'url'),
    firstImage(html),
  ];
  for (const c of candidates) {
    const abs = absoluteUrl(c, baseUrl);
    if (abs) return abs;
  }
  return undefined;
}

function atomLink(links: X[], baseUrl: string): string | undefined {
  const alt = links.find((l) => (attr(l, 'rel') ?? 'alternate') === 'alternate' && attr(l, 'href')) ?? links.find((l) => attr(l, 'href') && attr(l, 'rel') !== 'enclosure' && attr(l, 'rel') !== 'self');
  return absoluteUrl(attr(alt, 'href'), baseUrl);
}

function parseItem(it: X, baseUrl: string, isAtom: boolean, withPodcast: boolean): ParsedItem {
  const title = htmlToText(str(it['title'])) || '';
  const linkNodes = arr(it['link']);
  const link = isAtom ? atomLink(linkNodes, baseUrl) : absoluteUrl(str(linkNodes.find((l) => typeof l === 'string' || l?.['#text'])), baseUrl);

  const enclosure = pickEnclosure(it, baseUrl);

  // The richest HTML body available.
  const encoded = it['content:encoded'] != null ? str(it['content:encoded']) : '';
  const atomContent = it['content'] != null ? (typeof it['content'] === 'object' && !it['content']['#text'] ? deepText(it['content']) : str(it['content'])) : '';
  const rawDescription = firstNonEmpty(str(it['description']), str(it['summary']), str(it['itunes:summary']), str(it['media:description']));
  const candidateHtml = firstNonEmpty(encoded, atomContent, rawDescription);
  const contentHtml = candidateHtml && looksLikeHtml(candidateHtml) ? candidateHtml.slice(0, MAX_CONTENT_CHARS) : undefined;

  const summarySource = firstNonEmpty(rawDescription, itunesSubtitle(it), candidateHtml);
  const summary = summaryFromHtml(summarySource);

  const authorNode = arr(it['author'])[0];
  const author = firstNonEmpty(str(it['dc:creator']), typeof authorNode === 'object' ? str(authorNode?.['name']) : str(authorNode), str(it['itunes:author'])) || undefined;

  const publishedAt = parseDate(firstNonEmpty(str(it['pubDate']), str(it['published']), str(it['dc:date']), str(it['updated']), str(it['date'])));

  const guidText = str(it['guid']) || str(it['id']);
  const guid = guidText || link || enclosure?.url || `h:${fnv1a(`${title}|${publishedAt ?? ''}`)}`;

  const categories = arr(it['category'])
    .map((c) => (typeof c === 'object' ? (attr(c, 'term') ?? attr(c, 'label') ?? str(c)) : String(c)))
    .map((c) => htmlToText(c ?? ''))
    .filter(Boolean);

  const item: ParsedItem = {
    guid,
    title: title || summary.slice(0, 80) || '(untitled)',
    link,
    author,
    publishedAt,
    summary,
    contentHtml,
    imageUrl: itemImage(it, candidateHtml, baseUrl),
    categories,
    enclosure,
  };
  if (withPodcast) item.podcast = parseItemPodcast(it, baseUrl);
  return item;
}

function itunesSubtitle(it: X): string {
  return str(it['itunes:subtitle']);
}

// ---------------------------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------------------------

function hasPodcastNamespace(node: X): boolean {
  return Object.keys(node).some((k) => k.startsWith('itunes:') || k.startsWith('podcast:'));
}

function detectKind(channel: X, items: ParsedItem[]): FeedKind {
  if (items.length === 0) return hasPodcastNamespace(channel) ? 'podcast' : 'article';
  const media = items.filter((i) => i.enclosure && isMedia(i.enclosure.type, i.enclosure.url)).length;
  if (media / items.length >= 0.5) return 'podcast';
  // Explicit podcast markup with at least some audio, or channel-level medium/guid.
  if (media > 0 && hasPodcastNamespace(channel)) return 'podcast';
  return 'article';
}

function sortAndLimit(items: ParsedItem[], limit: number): ParsedItem[] {
  const dated = items.filter((i) => i.publishedAt != null).length;
  const sorted = dated >= items.length / 2 ? [...items].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)) : items;
  return sorted.slice(0, limit);
}

function dedupeGuids(items: ParsedItem[]): ParsedItem[] {
  const seen = new Set<string>();
  const out: ParsedItem[] = [];
  for (const item of items) {
    let guid = item.guid;
    for (let n = 2; seen.has(guid); n++) guid = `${item.guid}#${n}`;
    seen.add(guid);
    out.push(guid === item.guid ? item : { ...item, guid });
  }
  return out;
}

export interface ParseOptions {
  /** URL the document was fetched from; used to resolve relative links. */
  url: string;
  /** Keep at most this many (newest) items. Default 300. */
  limit?: number;
}

export function parseFeed(source: string, options: ParseOptions): ParsedFeed {
  const trimmed = source.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, options);
  if (!/<(rss|feed|rdf:RDF)\b/i.test(trimmed.slice(0, 4096))) {
    throw new Error('This URL does not look like an RSS, Atom or JSON feed');
  }

  let doc: X;
  try {
    doc = xml.parse(normalizePrefixes(trimmed));
  } catch (err) {
    throw new Error(`The feed is not valid XML: ${(err as Error).message}`);
  }
  const limit = options.limit ?? 300;
  const baseUrl = options.url;

  const isAtom = doc.feed != null;
  const isRdf = doc['rdf:RDF'] != null;
  let channel: X;
  let rawItems: X[];
  if (isAtom) {
    channel = doc.feed;
    rawItems = arr(channel.entry);
  } else if (isRdf) {
    const rdf = doc['rdf:RDF'];
    channel = arr(rdf.channel)[0] ?? {};
    rawItems = arr(rdf.item);
  } else {
    channel = arr(doc.rss?.channel)[0];
    if (!channel) throw new Error('The feed has no <channel>');
    rawItems = arr(channel.item);
  }

  const podcastMarkup = hasPodcastNamespace(channel) || rawItems.some((i) => hasPodcastNamespace(i));
  const parsedItems = rawItems.map((it) => parseItem(it, baseUrl, isAtom, podcastMarkup));
  const kind = detectKind(channel, parsedItems);
  const items = dedupeGuids(sortAndLimit(parsedItems, limit));

  const feedBase = isAtom ? (atomLink(arr(channel.link), baseUrl) ?? baseUrl) : (absoluteUrl(str(arr(channel.link).find((l) => typeof l === 'string')), baseUrl) ?? baseUrl);
  const imageNode = arr(channel.image)[0];
  const imageUrl = absoluteUrl(
    firstNonEmpty(attr(arr(channel['itunes:image'])[0], 'href'), str(imageNode?.url), str(channel.logo), str(channel.icon)),
    baseUrl,
  );

  const description = summaryFromHtml(firstNonEmpty(str(channel.description), str(channel.subtitle), str(channel['itunes:summary'])), 1000);
  const categories = [
    ...arr(channel.category).map((c) => htmlToText(typeof c === 'object' ? (attr(c, 'term') ?? str(c)) : String(c))),
    ...parseItunesCategories(channel),
  ].filter(Boolean);

  const authorNode = arr(channel.author)[0];
  return {
    kind,
    url: baseUrl,
    title: htmlToText(str(channel.title)) || new URL(baseUrl).hostname,
    description,
    link: feedBase === baseUrl && !isAtom ? undefined : feedBase,
    imageUrl,
    language: str(channel.language) || attr(channel, 'xml:lang') || undefined,
    author: firstNonEmpty(str(channel['itunes:author']), typeof authorNode === 'object' ? str(authorNode?.name) : str(authorNode), str(channel['dc:creator']), str(channel.managingEditor)) || undefined,
    categories: [...new Set(categories)],
    podcast: kind === 'podcast' || podcastMarkup ? parseChannelPodcast(channel) : undefined,
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// JSON Feed (https://jsonfeed.org)
// ---------------------------------------------------------------------------------------------

function parseJsonFeed(source: string, options: ParseOptions): ParsedFeed {
  let data: X;
  try {
    data = JSON.parse(source);
  } catch {
    throw new Error('The feed is not valid JSON');
  }
  if (typeof data?.version !== 'string' || !data.version.includes('jsonfeed.org')) {
    throw new Error('This JSON document is not a JSON Feed');
  }
  const base = options.url;
  const items: ParsedItem[] = arr(data.items).map((it: X): ParsedItem => {
    const html: string | undefined = typeof it.content_html === 'string' ? it.content_html : undefined;
    const attachments = arr(it.attachments);
    const att = attachments.find((a: X) => isMedia(a.mime_type, a.url)) ?? attachments[0];
    const enclosure = att?.url ? { url: absoluteUrl(att.url, base) ?? att.url, type: att.mime_type, length: att.size_in_bytes } : undefined;
    const link = absoluteUrl(it.url, base);
    const publishedAt = parseDate(it.date_published ?? it.date_modified);
    const title = htmlToText(it.title ?? '');
    const summary = summaryFromHtml(firstNonEmpty(it.summary, it.content_text, html));
    const item: ParsedItem = {
      guid: String(it.id ?? link ?? `h:${fnv1a(`${title}|${publishedAt ?? ''}`)}`),
      title: title || summary.slice(0, 80) || '(untitled)',
      link,
      author: arr(it.authors)[0]?.name ?? arr(data.authors)[0]?.name,
      publishedAt,
      summary,
      contentHtml: html?.slice(0, MAX_CONTENT_CHARS),
      imageUrl: absoluteUrl(it.image ?? it.banner_image, base) ?? firstImageOf(html, base),
      categories: arr(it.tags).map(String),
      enclosure,
    };
    if (att?.duration_in_seconds) {
      item.podcast = { duration: Math.round(att.duration_in_seconds), transcripts: [], persons: [], soundbites: [], alternateEnclosures: [], funding: [] };
    }
    return item;
  });
  const podcastItems = items.filter((i) => i.enclosure && isMedia(i.enclosure.type, i.enclosure.url)).length;
  const kind: FeedKind = items.length > 0 && podcastItems / items.length >= 0.5 ? 'podcast' : 'article';
  return {
    kind,
    url: base,
    title: htmlToText(data.title ?? '') || new URL(base).hostname,
    description: summaryFromHtml(data.description ?? '', 1000),
    link: absoluteUrl(data.home_page_url, base),
    imageUrl: absoluteUrl(data.icon ?? data.favicon, base),
    language: data.language,
    author: arr(data.authors)[0]?.name,
    categories: [],
    items: dedupeGuids(sortAndLimit(items, options.limit ?? 300)),
  };
}

function firstImageOf(html: string | undefined, base: string): string | undefined {
  return absoluteUrl(firstImage(html), base);
}
