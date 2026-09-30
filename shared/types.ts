/**
 * Types shared by the server (which parses feeds) and the client (which stores and renders them).
 * Everything here must be JSON-serialisable: it crosses the /api boundary as-is.
 */

export type FeedKind = 'article' | 'podcast';

export interface Person {
  name: string;
  role?: string;
  group?: string;
  img?: string;
  href?: string;
}

export interface ValueRecipient {
  name?: string;
  /** `node` = keysend to a node pubkey, `lnaddress` = lightning address (LNURL-pay). */
  type: string;
  address: string;
  /** Extra TLV record for keysend, e.g. key "696969" / value "<account id>". */
  customKey?: string;
  customValue?: string;
  /** Number of shares (or a percentage when `fee` is true). */
  split: number;
  fee?: boolean;
}

export interface ValueBlock {
  /** Always "lightning" in practice. */
  type: string;
  /** Always "keysend" in practice. */
  method: string;
  /** Suggested sats per minute (already converted from the spec's BTC decimal). */
  suggestedSatsPerMinute?: number;
  recipients: ValueRecipient[];
}

export interface Funding {
  url: string;
  text?: string;
}

export interface TranscriptRef {
  url: string;
  /** MIME type, e.g. text/vtt, application/srt, application/json, text/html, text/plain. */
  type: string;
  language?: string;
  rel?: string;
}

export interface ChaptersRef {
  url: string;
  type: string;
}

export interface Soundbite {
  startTime: number;
  duration: number;
  title?: string;
}

export interface AlternateEnclosure {
  type: string;
  length?: number;
  bitrate?: number;
  title?: string;
  lang?: string;
  default?: boolean;
  sources: { uri: string; contentType?: string }[];
}

export interface PodcastChannelMeta {
  // Podcasting 1.0 (RSS 2.0 + iTunes namespace)
  author?: string;
  ownerName?: string;
  ownerEmail?: string;
  explicit?: boolean;
  /** `episodic` (newest first) or `serial` (oldest first). */
  showType?: 'episodic' | 'serial';
  itunesCategories: string[];
  copyright?: string;
  newFeedUrl?: string;
  // Podcasting 2.0 (podcast: namespace)
  guid?: string;
  locked?: boolean;
  medium?: string;
  funding: Funding[];
  persons: Person[];
  value?: ValueBlock;
  license?: string;
  txt: { purpose?: string; text: string }[];
}

export interface PodcastItemMeta {
  duration?: number;
  episode?: number;
  episodeDisplay?: string;
  season?: number;
  seasonName?: string;
  episodeType?: 'full' | 'trailer' | 'bonus';
  explicit?: boolean;
  transcripts: TranscriptRef[];
  chapters?: ChaptersRef;
  persons: Person[];
  value?: ValueBlock;
  soundbites: Soundbite[];
  alternateEnclosures: AlternateEnclosure[];
  funding: Funding[];
  license?: string;
}

export interface Enclosure {
  url: string;
  type?: string;
  length?: number;
}

export interface ParsedItem {
  /** Stable identifier: <guid>, else link, else enclosure URL, else a hash of title+date. */
  guid: string;
  title: string;
  link?: string;
  author?: string;
  /** Milliseconds since epoch. */
  publishedAt?: number;
  /** Plain-text summary supplied by the feed (never contains markup). */
  summary: string;
  /** Raw HTML body from the feed. Untrusted: sanitise before rendering. */
  contentHtml?: string;
  imageUrl?: string;
  categories: string[];
  enclosure?: Enclosure;
  podcast?: PodcastItemMeta;
}

export interface ParsedFeed {
  kind: FeedKind;
  /** URL the feed was actually fetched from (after redirects). */
  url: string;
  title: string;
  description: string;
  link?: string;
  imageUrl?: string;
  language?: string;
  author?: string;
  categories: string[];
  podcast?: PodcastChannelMeta;
  items: ParsedItem[];
  etag?: string;
  lastModified?: string;
}

/** `GET /api/feed` returns this when the caller's validators still match. */
export interface FeedNotModified {
  notModified: true;
}

export interface ExtractedArticle {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  lang?: string;
  excerpt?: string;
  /** Readable body as HTML. Untrusted: sanitise before rendering. */
  contentHtml: string;
  /** Readable body as plain text with paragraph breaks preserved. */
  text: string;
  publishedAt?: number;
}

export interface TranscriptSegment {
  /** Seconds. */
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

export interface Transcript {
  /** False when the source had no timing information (plain text / HTML). */
  timed: boolean;
  segments: TranscriptSegment[];
}

export interface Chapter {
  startTime: number;
  title: string;
  img?: string;
  url?: string;
  /** `false` marks chapters that should not show in a table of contents. */
  toc?: boolean;
}

export interface BtcHistory {
  currency: string;
  /** Latest spot price. */
  current: number;
  /** Unix ms when `current` was observed. */
  asOf: number;
  /** Which upstream served this data. */
  source: string;
  /** [unix ms, price], ~hourly for the last 31 days. */
  hourly: [number, number][];
  /** [unix ms, price], daily for the last 366 days. */
  daily: [number, number][];
}

export type BtcPeriod = '1W' | '1M' | '1Y' | 'YTD';

export interface BtcPeriodChange {
  period: BtcPeriod;
  /** Price at the start of the period. */
  from: number;
  /** Absolute change in `currency`. */
  change: number;
  /** Percentage change (e.g. 12.5 for +12.5%). */
  pct: number;
  /** Points for charting, oldest first, ending at the current price. */
  series: [number, number][];
}

export type TranscribeStatus = 'queued' | 'downloading' | 'transcribing' | 'done' | 'error' | 'cancelled';

export interface TranscribeJobState {
  id: string;
  status: TranscribeStatus;
  /** 0..1 when the total duration is known, otherwise undefined. */
  progress?: number;
  /** Seconds of audio processed so far. */
  processedSeconds: number;
  model: string;
  error?: string;
  /** Segments starting at index `since` (see the `since` query parameter). */
  segments: TranscriptSegment[];
  /** Total number of segments produced so far. */
  total: number;
}

export interface Capabilities {
  ffmpeg: { available: boolean; path?: string };
  whisper: { available: boolean; reason?: string; models: WhisperModelInfo[]; dataDir: string };
}

export interface WhisperModelInfo {
  id: string;
  label: string;
  multilingual: boolean;
  approxMb: number;
}
