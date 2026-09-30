import { describe, expect, it } from 'vitest';
import { buildOpml, parseOpml } from './opml';

const SAMPLE = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="Hacker News" xmlUrl="https://news.ycombinator.com/rss" htmlUrl="https://news.ycombinator.com/"/>
      <outline type="rss" title="Ars" xmlUrl="https://feeds.arstechnica.com/arstechnica/index"/>
      <outline text="Nested">
        <outline type="rss" text="Deep" xmlUrl="https://deep.example/feed"/>
      </outline>
    </outline>
    <outline type="rss" text="Top level &amp; proud" xmlUrl="https://example.com/rss"/>
    <outline type="rss" text="Dupe" xmlUrl="https://example.com/rss"/>
    <outline type="rss" text="Bad scheme" xmlUrl="ftp://example.com/rss"/>
    <outline text="Empty folder"/>
  </body>
</opml>`;

describe('parseOpml', () => {
  it('extracts feeds with their folder, drops duplicates and non-http urls', () => {
    expect(parseOpml(SAMPLE)).toEqual([
      { title: 'Hacker News', xmlUrl: 'https://news.ycombinator.com/rss', htmlUrl: 'https://news.ycombinator.com/', category: 'Tech' },
      { title: 'Ars', xmlUrl: 'https://feeds.arstechnica.com/arstechnica/index', htmlUrl: undefined, category: 'Tech' },
      { title: 'Deep', xmlUrl: 'https://deep.example/feed', htmlUrl: undefined, category: 'Nested' },
      { title: 'Top level & proud', xmlUrl: 'https://example.com/rss', htmlUrl: undefined, category: undefined },
    ]);
  });

  it('rejects documents that are not OPML', () => {
    expect(() => parseOpml('<rss><channel/></rss>')).toThrow(/OPML/);
  });
});

describe('buildOpml', () => {
  it('produces a document parseOpml reads back, escaping special characters', () => {
    const xml = buildOpml('My <feeds>', [
      { category: 'News & Views', feeds: [{ title: 'A "quoted" feed', xmlUrl: 'https://a.example/rss?x=1&y=2' }] },
      { feeds: [{ title: 'Loose', xmlUrl: 'https://b.example/rss', htmlUrl: 'https://b.example' }] },
    ]);
    expect(xml).toContain('<title>My &lt;feeds&gt;</title>');
    expect(parseOpml(xml)).toEqual([
      { title: 'A "quoted" feed', xmlUrl: 'https://a.example/rss?x=1&y=2', htmlUrl: undefined, category: 'News & Views' },
      { title: 'Loose', xmlUrl: 'https://b.example/rss', htmlUrl: 'https://b.example', category: undefined },
    ]);
  });
});
