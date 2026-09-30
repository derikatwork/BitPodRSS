import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOpml } from '../../shared/opml';
import type { FeedNotModified, ParsedFeed, ParsedItem } from '../../shared/types';
import { api } from '../api';
import { db } from '../db';
import { MAX_ARTICLES_PER_FEED, addFeed, exportOpml, importOpml, normalizeInputUrl, refreshAll, refreshFeed, refreshPodcast } from './ingest';

vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), api: { feed: vi.fn() } }));
const feedMock = vi.mocked(api.feed);

const item = (n: number, extra: Partial<ParsedItem> = {}): ParsedItem => ({ guid: `g${n}`, title: `Article ${n}`, summary: `Summary ${n}`, categories: [], publishedAt: 1_700_000_000_000 + n * 1000, link: `https://site.example/${n}`, ...extra });
const feed = (url: string, items: ParsedItem[], extra: Partial<ParsedFeed> = {}): ParsedFeed => ({ kind: 'article', url, title: 'Site', description: '', categories: [], items, ...extra });
const episode = (n: number): ParsedItem => item(n, { enclosure: { url: `https://cdn.example/${n}.mp3`, type: 'audio/mpeg' }, podcast: { duration: 60 * n, transcripts: [], persons: [], soundbites: [], alternateEnclosures: [], funding: [] } });
const podcast = (url: string, items: ParsedItem[]): ParsedFeed => feed(url, items, { kind: 'podcast', title: 'Show', podcast: { itunesCategories: [], funding: [], persons: [], txt: [], author: 'Host' } });

beforeEach(async () => {
  feedMock.mockReset();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('normalizeInputUrl', () => {
  it('adds a scheme and handles feed://', () => {
    expect(normalizeInputUrl('example.com/rss')).toBe('https://example.com/rss');
    expect(normalizeInputUrl(' feed://example.com/rss ')).toBe('https://example.com/rss');
    expect(normalizeInputUrl('http://example.com')).toBe('http://example.com');
    expect(() => normalizeInputUrl('  ')).toThrow();
  });
});

describe('addFeed (articles)', () => {
  it('stores the feed and its articles, unread', async () => {
    feedMock.mockResolvedValue(feed('https://site.example/rss', [item(1), item(2)]));
    const r = await addFeed('site.example/rss');
    expect(r).toMatchObject({ kind: 'article', existed: false, added: 2, routed: false });
    expect(await db.articles.count()).toBe(2);
    expect((await db.articles.toArray()).every((a) => a.read === 0 && a.starred === 0)).toBe(true);
  });

  it('does not add the same feed twice, even when typed differently', async () => {
    feedMock.mockResolvedValue(feed('https://site.example/rss', [item(1)]));
    await addFeed('https://site.example/rss');
    const again = await addFeed('site.example/rss');
    expect(again.existed).toBe(true);
    expect(await db.feeds.count()).toBe(1);
    expect(await db.articles.count()).toBe(1);
  });

  it('assigns the chosen category', async () => {
    const categoryId = await db.categories.add({ name: 'News', order: 0 });
    feedMock.mockResolvedValue(feed('https://site.example/rss', [item(1)]));
    const r = await addFeed('https://site.example/rss', { categoryId });
    expect((await db.feeds.get(r.id))!.categoryId).toBe(categoryId);
  });
});

describe('refreshFeed', () => {
  it('adds only new articles and keeps read/starred state and stored full text', async () => {
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', [item(1), item(2)]));
    const { id } = await addFeed('https://site.example/rss');
    const a1 = (await db.articles.filter((a) => a.guid === 'g1').first())!;
    await db.articles.update(a1.id, { read: 1, starred: 1, extracted: { text: 't', contentHtml: '<p>t</p>' } });

    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', [item(1, { title: 'Article 1 (edited)' }), item(2), item(3)], { etag: '"v2"' }));
    expect(await refreshFeed(id)).toBe(1);

    const after = (await db.articles.filter((a) => a.guid === 'g1').first())!;
    expect(after).toMatchObject({ title: 'Article 1 (edited)', read: 1, starred: 1, extracted: { text: 't' } });
    expect(await db.articles.count()).toBe(3);
    expect((await db.feeds.get(id))!.etag).toBe('"v2"');
  });

  it('sends stored validators and treats 304 as nothing new', async () => {
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', [item(1)], { etag: '"v1"', lastModified: 'yesterday' }));
    const { id } = await addFeed('https://site.example/rss');
    feedMock.mockResolvedValueOnce({ notModified: true } satisfies FeedNotModified);
    expect(await refreshFeed(id)).toBe(0);
    expect(feedMock).toHaveBeenLastCalledWith('https://site.example/rss', { etag: '"v1"', lastModified: 'yesterday' });
  });

  it('records errors on the feed and rethrows', async () => {
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', [item(1)]));
    const { id } = await addFeed('https://site.example/rss');
    feedMock.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(refreshFeed(id)).rejects.toThrow('HTTP 500');
    expect((await db.feeds.get(id))!.lastError).toBe('HTTP 500');
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', [item(1)]));
    await refreshFeed(id);
    expect((await db.feeds.get(id))!.lastError).toBeUndefined();
  });

  it('prunes the oldest non-starred articles beyond the cap', async () => {
    const many = Array.from({ length: MAX_ARTICLES_PER_FEED + 20 }, (_, i) => item(i));
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', many.slice(0, 10)));
    const { id } = await addFeed('https://site.example/rss');
    const oldest = (await db.articles.filter((a) => a.guid === 'g0').first())!;
    await db.articles.update(oldest.id, { starred: 1 });
    feedMock.mockResolvedValueOnce(feed('https://site.example/rss', many));
    await refreshFeed(id);
    expect(await db.articles.count()).toBe(MAX_ARTICLES_PER_FEED);
    expect(await db.articles.filter((a) => a.guid === 'g0').count()).toBe(1); // starred survives
    expect(await db.articles.filter((a) => a.guid === 'g1').count()).toBe(0); // oldest unstarred pruned
  });
});

describe('podcasts', () => {
  it('stores episodes with duration and metadata and preserves playback state on refresh', async () => {
    feedMock.mockResolvedValueOnce(podcast('https://show.example/rss', [episode(1), episode(2)]));
    const r = await addFeed('https://show.example/rss', { target: 'podcast' });
    expect(r).toMatchObject({ kind: 'podcast', added: 2, routed: false });
    const podcastRow = (await db.podcasts.get(r.id))!;
    expect(podcastRow.author).toBe('Host');

    const ep1 = (await db.episodes.filter((e) => e.guid === 'g1').first())!;
    expect(ep1).toMatchObject({ duration: 60, enclosureUrl: 'https://cdn.example/1.mp3', played: 0, position: 0 });
    await db.episodes.update(ep1.id, { position: 42, played: 1 });

    feedMock.mockResolvedValueOnce(podcast('https://show.example/rss', [episode(1), episode(2), episode(3)]));
    expect(await refreshPodcast(r.id)).toBe(1);
    expect(await db.episodes.get(ep1.id)).toMatchObject({ position: 42, played: 1 });
  });

  it('routes a podcast feed added from the Reader to Podcasts, and skips blog posts without audio', async () => {
    feedMock.mockResolvedValueOnce(podcast('https://show.example/rss', [episode(1), item(2)]));
    const r = await addFeed('https://show.example/rss', { target: 'article' });
    expect(r).toMatchObject({ kind: 'podcast', routed: true, added: 1 });
    expect(await db.feeds.count()).toBe(0);
    expect(await db.podcasts.count()).toBe(1);
  });

  it('refuses to add a text-only feed as a podcast, but accepts one that has enclosures', async () => {
    feedMock.mockResolvedValueOnce(feed('https://blog.example/rss', [item(1)]));
    await expect(addFeed('https://blog.example/rss', { target: 'podcast' })).rejects.toThrow(/no audio/);
    feedMock.mockResolvedValueOnce(feed('https://blog.example/rss2', [episode(1)]));
    expect((await addFeed('https://blog.example/rss2', { target: 'podcast' })).kind).toBe('podcast');
  });
});

describe('refreshAll', () => {
  it('counts successes, failures and new items across both kinds', async () => {
    feedMock.mockResolvedValueOnce(feed('https://a.example/rss', [item(1)]));
    feedMock.mockResolvedValueOnce(feed('https://b.example/rss', [item(1)]));
    feedMock.mockResolvedValueOnce(podcast('https://p.example/rss', [episode(1)]));
    await addFeed('https://a.example/rss');
    await addFeed('https://b.example/rss');
    await addFeed('https://p.example/rss');

    feedMock.mockImplementation(async (url) => {
      if (url.startsWith('https://b.')) throw new Error('down');
      if (url.startsWith('https://a.')) return feed(url, [item(1), item(2)]);
      return podcast(url, [episode(1), episode(2), episode(3)]);
    });
    expect(await refreshAll()).toEqual({ ok: 2, failed: 1, newItems: 3 });
    feedMock.mockClear();
    await refreshAll('podcast');
    expect(feedMock).toHaveBeenCalledTimes(1);
  });
});

describe('OPML', () => {
  it('imports folders as categories (articles) and groups (podcasts) and reports failures', async () => {
    feedMock.mockImplementation(async (url) => {
      if (url.includes('broken')) throw new Error('HTTP 404');
      return url.includes('pod') ? podcast(url, [episode(1)]) : feed(url, [item(1)]);
    });
    const progress: number[] = [];
    const r = await importOpml(
      [
        { title: 'A', xmlUrl: 'https://news.example/rss', category: 'News' },
        { title: 'B', xmlUrl: 'https://pod.example/rss', category: 'Audio' },
        { title: 'C', xmlUrl: 'https://broken.example/rss' },
        { title: 'D', xmlUrl: 'https://plain.example/rss' },
      ],
      (done) => progress.push(done),
    );
    expect(r.added).toBe(3);
    expect(r.failed).toEqual([{ url: 'https://broken.example/rss', error: 'HTTP 404' }]);
    expect(progress[progress.length - 1]).toBe(4);
    expect((await db.categories.toArray()).map((c) => c.name)).toEqual(['News']);
    expect((await db.groups.toArray()).map((g) => g.name)).toEqual(['Audio']);
    const news = (await db.feeds.where('url').equals('https://news.example/rss').first())!;
    expect(news.categoryId).toBeDefined();
    const again = await importOpml([{ title: 'A', xmlUrl: 'https://news.example/rss', category: 'News' }]);
    expect(again).toMatchObject({ added: 0, existed: 1 });
  });

  it('exports what was imported', async () => {
    feedMock.mockImplementation(async (url) => (url.includes('pod') ? podcast(url, [episode(1)]) : feed(url, [item(1)])));
    await importOpml([
      { title: 'A', xmlUrl: 'https://news.example/rss', category: 'News' },
      { title: 'B', xmlUrl: 'https://pod.example/rss', category: 'Audio' },
      { title: 'D', xmlUrl: 'https://plain.example/rss' },
    ]);
    const exported = parseOpml(await exportOpml());
    expect(exported.map((f) => [f.xmlUrl, f.category])).toEqual(
      expect.arrayContaining([
        ['https://news.example/rss', 'News'],
        ['https://pod.example/rss', 'Audio'],
        ['https://plain.example/rss', undefined],
      ]),
    );
    expect(exported).toHaveLength(3);
  });
});
