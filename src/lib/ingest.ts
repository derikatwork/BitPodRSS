import { buildOpml, type OpmlFeed } from '../../shared/opml';
import type { FeedKind, ParsedFeed } from '../../shared/types';
import { api, isNotModified } from '../api';
import { db, type Article, type Episode } from '../db';

/** Most articles kept per feed (starred ones are never pruned). */
export const MAX_ARTICLES_PER_FEED = 300;

export interface AddResult {
  kind: FeedKind;
  id: number;
  title: string;
  /** The subscription already existed; nothing was added. */
  existed: boolean;
  /** Items stored from the first fetch. */
  added: number;
  /** The feed went to a different section than the one the user added it from. */
  routed: boolean;
}

/** Accept "example.com/feed" as well as full URLs. */
export function normalizeInputUrl(input: string): string {
  const trimmed = input.trim().replace(/^feed:\/\//i, 'https://');
  if (!trimmed) throw new Error('Enter a feed or website address');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function ingestArticles(feedId: number, parsed: ParsedFeed, now: number): Promise<number> {
  const existing = await db.articles
    .where('[feedId+guid]')
    .anyOf(parsed.items.map((i) => [feedId, i.guid] as [number, string]))
    .toArray();
  const byGuid = new Map(existing.map((a) => [a.guid, a]));

  const fresh: Omit<Article, 'id'>[] = [];
  const updates: { id: number; changes: Partial<Article> }[] = [];
  for (const item of parsed.items) {
    const current = byGuid.get(item.guid);
    if (!current) {
      fresh.push({
        feedId,
        guid: item.guid,
        title: item.title,
        link: item.link,
        author: item.author,
        publishedAt: item.publishedAt ?? now,
        summary: item.summary,
        contentHtml: item.contentHtml,
        imageUrl: item.imageUrl,
        read: 0,
        starred: 0,
        fetchedAt: now,
      });
    } else if (current.title !== item.title || current.summary !== item.summary || current.contentHtml !== item.contentHtml) {
      updates.push({ id: current.id, changes: { title: item.title, summary: item.summary, contentHtml: item.contentHtml, imageUrl: item.imageUrl ?? current.imageUrl } });
    }
  }

  await db.transaction('rw', db.articles, async () => {
    if (fresh.length) await db.articles.bulkAdd(fresh);
    for (const u of updates) await db.articles.update(u.id, u.changes);
    const count = await db.articles.where('feedId').equals(feedId).count();
    if (count > MAX_ARTICLES_PER_FEED) {
      const prunable = await db.articles.where('feedId').equals(feedId).filter((a) => a.starred === 0).sortBy('publishedAt');
      const excess = prunable.slice(0, count - MAX_ARTICLES_PER_FEED).map((a) => a.id);
      await db.articles.bulkDelete(excess);
    }
  });
  return fresh.length;
}

async function ingestEpisodes(podcastId: number, parsed: ParsedFeed, now: number): Promise<number> {
  const items = parsed.items.filter((i) => i.enclosure);
  const existing = await db.episodes
    .where('[podcastId+guid]')
    .anyOf(items.map((i) => [podcastId, i.guid] as [number, string]))
    .toArray();
  const byGuid = new Map(existing.map((e) => [e.guid, e]));

  const fresh: Omit<Episode, 'id'>[] = [];
  const updates: { id: number; changes: Partial<Episode> }[] = [];
  for (const item of items) {
    const enclosure = item.enclosure!;
    const current = byGuid.get(item.guid);
    const fields = {
      title: item.title,
      link: item.link,
      summary: item.summary,
      contentHtml: item.contentHtml,
      imageUrl: item.imageUrl,
      enclosureUrl: enclosure.url,
      enclosureType: enclosure.type,
      duration: item.podcast?.duration,
      meta: item.podcast,
    };
    if (!current) {
      fresh.push({ podcastId, guid: item.guid, publishedAt: item.publishedAt ?? now, played: 0, position: 0, addedAt: now, ...fields });
    } else {
      updates.push({ id: current.id, changes: fields });
    }
  }

  await db.transaction('rw', db.episodes, async () => {
    if (fresh.length) await db.episodes.bulkAdd(fresh);
    for (const u of updates) await db.episodes.update(u.id, u.changes);
  });
  return fresh.length;
}

export async function addFeed(
  input: string,
  opts: { target?: FeedKind; categoryId?: number; groupIds?: number[] } = {},
): Promise<AddResult> {
  const url = normalizeInputUrl(input);
  const fetched = await api.feed(url);
  if (isNotModified(fetched)) throw new Error('Unexpected response from the server');
  const parsed = fetched;
  const now = Date.now();

  let kind = parsed.kind;
  if (opts.target === 'podcast' && kind === 'article') {
    if (!parsed.items.some((i) => i.enclosure)) {
      throw new Error('This feed has no audio or video episodes, so it cannot be added as a podcast. Add it in the Reader instead.');
    }
    kind = 'podcast';
  }
  const routed = opts.target !== undefined && kind !== opts.target;

  if (kind === 'article') {
    const existing = (await db.feeds.where('url').equals(parsed.url).first()) ?? (await db.feeds.where('url').equals(url).first());
    if (existing) return { kind, id: existing.id, title: existing.title, existed: true, added: 0, routed };
    const id = await db.feeds.add({
      url: parsed.url,
      title: parsed.title,
      description: parsed.description,
      link: parsed.link,
      imageUrl: parsed.imageUrl,
      categoryId: opts.categoryId,
      etag: parsed.etag,
      lastModified: parsed.lastModified,
      lastFetched: now,
      addedAt: now,
    });
    const added = await ingestArticles(id, parsed, now);
    return { kind, id, title: parsed.title, existed: false, added, routed };
  }

  const existing = (await db.podcasts.where('url').equals(parsed.url).first()) ?? (await db.podcasts.where('url').equals(url).first());
  if (existing) return { kind, id: existing.id, title: existing.title, existed: true, added: 0, routed };
  const id = await db.podcasts.add({
    url: parsed.url,
    title: parsed.title,
    author: parsed.podcast?.author ?? parsed.author,
    description: parsed.description,
    imageUrl: parsed.imageUrl,
    link: parsed.link,
    language: parsed.language,
    groupIds: opts.groupIds ?? [],
    meta: parsed.podcast,
    etag: parsed.etag,
    lastModified: parsed.lastModified,
    lastFetched: now,
    addedAt: now,
  });
  const added = await ingestEpisodes(id, parsed, now);
  return { kind, id, title: parsed.title, existed: false, added, routed };
}

/** Re-fetch one article feed. Returns the number of new articles. */
export async function refreshFeed(id: number): Promise<number> {
  const feed = await db.feeds.get(id);
  if (!feed) return 0;
  const now = Date.now();
  try {
    const r = await api.feed(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
    if (isNotModified(r)) {
      await db.feeds.update(id, { lastFetched: now, lastError: undefined });
      return 0;
    }
    const added = await ingestArticles(id, r, now);
    await db.feeds.update(id, { title: r.title || feed.title, description: r.description, imageUrl: r.imageUrl ?? feed.imageUrl, etag: r.etag, lastModified: r.lastModified, lastFetched: now, lastError: undefined });
    return added;
  } catch (err) {
    await db.feeds.update(id, { lastError: (err as Error).message, lastFetched: now });
    throw err;
  }
}

/** Re-fetch one podcast. Returns the number of new episodes. */
export async function refreshPodcast(id: number): Promise<number> {
  const podcast = await db.podcasts.get(id);
  if (!podcast) return 0;
  const now = Date.now();
  try {
    const r = await api.feed(podcast.url, { etag: podcast.etag, lastModified: podcast.lastModified });
    if (isNotModified(r)) {
      await db.podcasts.update(id, { lastFetched: now, lastError: undefined });
      return 0;
    }
    const added = await ingestEpisodes(id, r, now);
    await db.podcasts.update(id, {
      title: r.title || podcast.title,
      author: r.podcast?.author ?? r.author ?? podcast.author,
      description: r.description,
      imageUrl: r.imageUrl ?? podcast.imageUrl,
      meta: r.podcast ?? podcast.meta,
      etag: r.etag,
      lastModified: r.lastModified,
      lastFetched: now,
      lastError: undefined,
    });
    return added;
  } catch (err) {
    await db.podcasts.update(id, { lastError: (err as Error).message, lastFetched: now });
    throw err;
  }
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]!);
    }),
  );
}

export interface RefreshSummary {
  ok: number;
  failed: number;
  newItems: number;
}

/** Refresh every subscription of the given kind (or both) a few at a time. */
export async function refreshAll(kind?: FeedKind): Promise<RefreshSummary> {
  const summary: RefreshSummary = { ok: 0, failed: 0, newItems: 0 };
  const jobs: (() => Promise<number>)[] = [];
  if (kind !== 'podcast') for (const f of await db.feeds.toArray()) jobs.push(() => refreshFeed(f.id));
  if (kind !== 'article') for (const p of await db.podcasts.toArray()) jobs.push(() => refreshPodcast(p.id));
  await pool(jobs, 4, async (job) => {
    try {
      // Not `newItems += await job()`: that reads newItems before the await and loses concurrent updates.
      const added = await job();
      summary.newItems += added;
      summary.ok++;
    } catch {
      summary.failed++;
    }
  });
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Categories, groups and OPML
// ---------------------------------------------------------------------------------------------

export async function ensureCategory(name: string): Promise<number> {
  const existing = await db.categories.filter((c) => c.name.toLowerCase() === name.toLowerCase()).first();
  if (existing) return existing.id;
  return db.categories.add({ name, order: await db.categories.count() });
}

export async function ensureGroup(name: string): Promise<number> {
  const existing = await db.groups.filter((g) => g.name.toLowerCase() === name.toLowerCase()).first();
  if (existing) return existing.id;
  return db.groups.add({ name, order: await db.groups.count() });
}

export interface OpmlImportResult {
  added: number;
  existed: number;
  failed: { url: string; error: string }[];
}

/** Subscribe to every feed in an OPML file. Folders become categories (articles) or groups (podcasts). */
export async function importOpml(
  feeds: OpmlFeed[],
  onProgress?: (done: number, total: number) => void,
): Promise<OpmlImportResult> {
  const result: OpmlImportResult = { added: 0, existed: 0, failed: [] };
  let done = 0;
  await pool(feeds, 3, async (f) => {
    try {
      const r = await addFeed(f.xmlUrl);
      if (r.existed) result.existed++;
      else {
        result.added++;
        if (f.category) {
          if (r.kind === 'article') await db.feeds.update(r.id, { categoryId: await ensureCategory(f.category) });
          else await db.podcasts.update(r.id, { groupIds: [await ensureGroup(f.category)] });
        }
      }
    } catch (err) {
      result.failed.push({ url: f.xmlUrl, error: (err as Error).message });
    }
    onProgress?.(++done, feeds.length);
  });
  return result;
}

/** OPML for all subscriptions, grouped by category / first group. */
export async function exportOpml(): Promise<string> {
  const [feeds, categories, podcasts, groups] = await Promise.all([db.feeds.toArray(), db.categories.orderBy('order').toArray(), db.podcasts.toArray(), db.groups.orderBy('order').toArray()]);
  const toItem = (x: { title: string; url: string; link?: string }) => ({ title: x.title, xmlUrl: x.url, htmlUrl: x.link });
  const byCategory = categories.map((c) => ({ category: c.name, feeds: feeds.filter((f) => f.categoryId === c.id).map(toItem) }));
  const uncategorized = { feeds: feeds.filter((f) => !categories.some((c) => c.id === f.categoryId)).map(toItem) };
  const byGroup = groups.map((g) => ({ category: g.name, feeds: podcasts.filter((p) => p.groupIds[0] === g.id).map(toItem) }));
  const ungrouped = { category: 'Podcasts', feeds: podcasts.filter((p) => !groups.some((g) => g.id === p.groupIds[0])).map(toItem) };
  return buildOpml('BitPodRSS subscriptions', [...byCategory, uncategorized, ...byGroup, ungrouped]);
}
