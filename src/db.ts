import Dexie, { type EntityTable } from 'dexie';
import type { PodcastChannelMeta, PodcastItemMeta, TranscriptSegment } from '../shared/types';

/** Booleans are stored as 0/1 because IndexedDB cannot index them. */
export type Flag = 0 | 1;

export interface Category {
  id: number;
  name: string;
  order: number;
}

export interface Feed {
  id: number;
  url: string;
  title: string;
  description: string;
  link?: string;
  imageUrl?: string;
  categoryId?: number;
  etag?: string;
  lastModified?: string;
  lastFetched?: number;
  lastError?: string;
  addedAt: number;
}

export interface ExtractedContent {
  text: string;
  contentHtml: string;
  byline?: string;
  siteName?: string;
}

export interface Article {
  id: number;
  feedId: number;
  guid: string;
  title: string;
  link?: string;
  author?: string;
  /** Publication time; falls back to the time we first saw the article. */
  publishedAt: number;
  summary: string;
  contentHtml?: string;
  imageUrl?: string;
  read: Flag;
  starred: Flag;
  fetchedAt: number;
  /** Full text fetched on demand from the article's page. */
  extracted?: ExtractedContent;
  /** Extractive summary of the full text. */
  autoSummary?: string;
}

export interface Group {
  id: number;
  name: string;
  order: number;
}

export interface Podcast {
  id: number;
  url: string;
  title: string;
  author?: string;
  description: string;
  imageUrl?: string;
  link?: string;
  language?: string;
  groupIds: number[];
  meta?: PodcastChannelMeta;
  etag?: string;
  lastModified?: string;
  lastFetched?: number;
  lastError?: string;
  addedAt: number;
}

export interface Episode {
  id: number;
  podcastId: number;
  guid: string;
  title: string;
  link?: string;
  publishedAt: number;
  summary: string;
  contentHtml?: string;
  imageUrl?: string;
  enclosureUrl: string;
  enclosureType?: string;
  /** Seconds. */
  duration?: number;
  meta?: PodcastItemMeta;
  played: Flag;
  /** Resume position in seconds. */
  position: number;
  addedAt: number;
}

export interface Queue {
  id: number;
  name: string;
  order: number;
  /** Episode ids in play order. */
  episodeIds: number[];
}

export interface StoredTranscript {
  id: number;
  episodeId: number;
  source: 'publisher' | 'local';
  model?: string;
  language?: string;
  timed: boolean;
  segments: TranscriptSegment[];
  createdAt: number;
}

export type LedgerKind = 'stream' | 'boost' | 'invoice' | 'lnaddress';

/** Every payment attempt the app makes, successful or not. Spending limits are enforced from this. */
export interface LedgerEntry {
  id: number;
  ts: number;
  kind: LedgerKind;
  sats: number;
  ok: Flag;
  podcastId?: number;
  episodeId?: number;
  recipient?: string;
  note?: string;
  error?: string;
}

/** A pair of articles the user confirmed are NOT duplicates. */
export interface DupIgnore {
  key: string;
}

export class AppDB extends Dexie {
  categories!: EntityTable<Category, 'id'>;
  feeds!: EntityTable<Feed, 'id'>;
  articles!: EntityTable<Article, 'id'>;
  groups!: EntityTable<Group, 'id'>;
  podcasts!: EntityTable<Podcast, 'id'>;
  episodes!: EntityTable<Episode, 'id'>;
  queues!: EntityTable<Queue, 'id'>;
  transcripts!: EntityTable<StoredTranscript, 'id'>;
  ledger!: EntityTable<LedgerEntry, 'id'>;
  dupIgnores!: EntityTable<DupIgnore, 'key'>;

  constructor(name = 'bitpodrss') {
    super(name);
    this.version(1).stores({
      categories: '++id, order',
      feeds: '++id, &url, categoryId',
      articles: '++id, &[feedId+guid], feedId, publishedAt, read, starred',
      groups: '++id, order',
      podcasts: '++id, &url, *groupIds',
      episodes: '++id, &[podcastId+guid], podcastId, publishedAt, played',
      queues: '++id, order',
      transcripts: '++id, &episodeId',
      ledger: '++id, ts, kind',
      dupIgnores: '&key',
    });
  }
}

export const db = new AppDB();
