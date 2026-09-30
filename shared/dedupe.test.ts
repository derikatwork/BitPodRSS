import { describe, expect, it } from 'vitest';
import { findDuplicates, pairKey, stripSiteSuffix, type DedupeItem } from './dedupe';
import { normalizeUrl } from './url';

const H = 3600_000;
const T0 = Date.UTC(2026, 5, 1, 12);

function item(id: number, feedId: number, title: string, extra: Partial<DedupeItem> = {}): DedupeItem {
  return { id, feedId, title, publishedAt: T0 + id * H, ...extra };
}

describe('normalizeUrl', () => {
  it('ignores tracking params, fragments, www, trailing slash and scheme', () => {
    const a = normalizeUrl('http://www.Example.com/news/story/?utm_source=x&fbclid=1&b=2&a=1#comments');
    const b = normalizeUrl('https://example.com/news/story?a=1&b=2');
    expect(a).toBe(b);
  });
  it('treats AMP variants as the same article', () => {
    expect(normalizeUrl('https://amp.example.com/story/amp/')).toBe(normalizeUrl('https://example.com/story'));
    expect(normalizeUrl('https://example.com/story?amp=1')).toBe(normalizeUrl('https://example.com/story'));
  });
  it('keeps meaningful query params', () => {
    expect(normalizeUrl('https://example.com/read?id=1')).not.toBe(normalizeUrl('https://example.com/read?id=2'));
  });
  it('rejects non-http urls', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeUrl('')).toBeUndefined();
    expect(normalizeUrl('not a url')).toBeUndefined();
  });
});

describe('stripSiteSuffix', () => {
  it('removes a trailing outlet name', () => {
    expect(stripSiteSuffix('Fed holds rates steady amid inflation worries - Reuters')).toBe('Fed holds rates steady amid inflation worries');
    expect(stripSiteSuffix('Fed holds rates steady amid inflation worries | The Daily Wire')).toBe('Fed holds rates steady amid inflation worries');
  });
  it('leaves short headlines alone', () => {
    expect(stripSiteSuffix('Mac - Tips')).toBe('Mac - Tips');
  });
});

describe('findDuplicates', () => {
  it('flags the same URL across feeds as an exact duplicate, ignoring tracking params', () => {
    const r = findDuplicates([
      item(1, 1, 'Completely different words here', { url: 'https://site.com/a/story?utm_medium=rss' }),
      item(2, 2, 'Another headline altogether', { url: 'http://www.site.com/a/story/' }),
    ]);
    expect(r.get(1)?.matches[0]).toMatchObject({ id: 2, kind: 'exact', score: 1 });
    expect(r.get(2)?.primaryId).toBe(1);
  });

  it('flags near-identical headlines from different outlets', () => {
    const r = findDuplicates([
      item(1, 1, 'Fed holds interest rates steady amid inflation worries - Reuters'),
      item(2, 2, 'Fed holds interest rates steady amid inflation worries | Bloomberg'),
    ]);
    expect(r.get(1)?.matches[0]?.kind).toBe('likely');
  });

  it('flags reworded headlines when the summaries match', () => {
    const summary =
      'The Federal Reserve left its benchmark interest rate unchanged on Wednesday as policymakers weighed stubborn inflation against a cooling labor market and signalled possible cuts later this year.';
    const r = findDuplicates([
      item(1, 1, 'Fed leaves rates unchanged, eyes cuts later in year', { summary }),
      item(2, 2, 'Central bank holds benchmark rate on Wednesday', { summary: summary + ' Markets reacted calmly.' }),
    ]);
    expect(r.size).toBe(2);
    expect(r.get(2)?.matches[0]?.id).toBe(1);
  });

  it('does not flag unrelated stories that share a common word', () => {
    const r = findDuplicates([
      item(1, 1, 'Bitcoin miners expand operations in Texas after hashrate record'),
      item(2, 2, 'Bitcoin price analysis: support holds near resistance zone today'),
      item(3, 3, 'Local bakery wins national award for sourdough bread'),
    ]);
    expect(r.size).toBe(0);
  });

  it('ignores generic two-word headlines unless the URL matches', () => {
    const r = findDuplicates([item(1, 1, 'Daily Update'), item(2, 2, 'Daily Update')]);
    expect(r.size).toBe(0);
  });

  it('only compares across feeds by default, but can compare within a feed', () => {
    const items = [item(1, 1, 'Storm batters the coast as thousands lose power overnight'), item(2, 1, 'Storm batters the coast as thousands lose power overnight')];
    expect(findDuplicates(items).size).toBe(0);
    expect(findDuplicates(items, { crossFeedOnly: false }).size).toBe(2);
  });

  it('does not compare articles published far apart', () => {
    const a = item(1, 1, 'Storm batters the coast as thousands lose power overnight', { publishedAt: T0 });
    const b = item(2, 2, 'Storm batters the coast as thousands lose power overnight', { publishedAt: T0 + 10 * 24 * H });
    expect(findDuplicates([a, b]).size).toBe(0);
    expect(findDuplicates([a, b], { windowMs: 30 * 24 * H }).size).toBe(2);
  });

  it('honours pairs the user dismissed', () => {
    const items = [item(1, 1, 'Storm batters the coast as thousands lose power overnight'), item(2, 2, 'Storm batters the coast as thousands lose power overnight')];
    expect(findDuplicates(items, { ignoredPairs: new Set([pairKey(2, 1)]) }).size).toBe(0);
  });

  it('groups three copies into one cluster headed by the earliest article', () => {
    const title = 'Regulators approve landmark merger between two rival chipmakers';
    const r = findDuplicates([item(3, 3, title), item(1, 1, title), item(2, 2, title + ' - Reuters')]);
    expect(r.size).toBe(3);
    for (const info of r.values()) {
      expect(info.size).toBe(3);
      expect(info.primaryId).toBe(1);
      expect(info.clusterId).toBe(1);
    }
  });

  it('is fast enough for a large library', () => {
    const words = ['market', 'rates', 'storm', 'election', 'launch', 'chip', 'energy', 'court', 'league', 'science', 'budget', 'trade', 'cyber', 'climate', 'health'];
    const items: DedupeItem[] = [];
    for (let i = 0; i < 5000; i++) {
      const t = `${words[i % 15]} ${words[(i * 7) % 15]} story number ${i} about ${words[(i * 3) % 15]} and topic${i % 400}`;
      items.push(item(i + 1, (i % 40) + 1, t, { summary: `summary for ${t} with enough extra words to count as evidence in the comparison stage ${i}` }));
    }
    const start = performance.now();
    findDuplicates(items);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
