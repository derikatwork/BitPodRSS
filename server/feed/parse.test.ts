import { describe, expect, it } from 'vitest';
import { normalizePrefixes, parseDate, parseFeed } from './parse';

const URL_ = 'https://podcast.example/feed.xml';

const PODCAST_20 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Sats &amp; Stories</title>
    <link>https://podcast.example</link>
    <description><![CDATA[<p>A show about <b>bitcoin</b> &amp; people.</p>]]></description>
    <language>en-us</language>
    <copyright>© 2026 Example</copyright>
    <atom:link href="https://podcast.example/feed.xml" rel="self" type="application/rss+xml"/>
    <itunes:author>Ada Example</itunes:author>
    <itunes:owner><itunes:name>Ada Owner</itunes:name><itunes:email>ada@podcast.example</itunes:email></itunes:owner>
    <itunes:explicit>no</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:image href="https://podcast.example/cover.jpg"/>
    <itunes:category text="Technology"><itunes:category text="Podcasting"/></itunes:category>
    <itunes:category text="Business"/>
    <podcast:guid>c3a7a1f0-0000-5000-8000-000000000001</podcast:guid>
    <podcast:locked owner="ada@podcast.example">yes</podcast:locked>
    <podcast:medium>podcast</podcast:medium>
    <podcast:funding url="https://podcast.example/support">Support the show</podcast:funding>
    <podcast:person role="host" img="https://podcast.example/ada.jpg" href="https://ada.example">Ada Example</podcast:person>
    <podcast:value type="lightning" method="keysend" suggested="0.00000015000">
      <podcast:valueRecipient name="Show" type="node" address="02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" split="90"/>
      <podcast:valueRecipient name="Alby user" type="node" address="030a58b8653d32b99200a2334cfe913e51dc7d155aa0116c176657a4f1722677a3" customKey="696969" customValue="abc123" split="5"/>
      <podcast:valueRecipient name="App fee" type="node" address="03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" split="5" fee="true"/>
    </podcast:value>
    <item>
      <title>Episode 2: Lightning &amp; Podcasts</title>
      <link>https://podcast.example/ep2</link>
      <guid isPermaLink="false">ep-2-guid</guid>
      <pubDate>Mon, 15 Jun 2026 08:00:00 GMT</pubDate>
      <description>Short teaser for episode 2.</description>
      <content:encoded><![CDATA[<p>Long <em>show notes</em> with a <a href="/links">link</a>.</p>]]></content:encoded>
      <enclosure url="https://cdn.example/ep2.mp3" length="12345678" type="audio/mpeg"/>
      <itunes:duration>1:02:03</itunes:duration>
      <itunes:episode>2</itunes:episode>
      <itunes:season>1</itunes:season>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:image href="https://podcast.example/ep2.jpg"/>
      <podcast:transcript url="/transcripts/ep2.vtt" type="text/vtt" language="en" rel="captions"/>
      <podcast:transcript url="https://podcast.example/transcripts/ep2.json" type="application/json"/>
      <podcast:chapters url="https://podcast.example/chapters/ep2.json" type="application/json+chapters"/>
      <podcast:soundbite startTime="73.0" duration="60.0">Best bit</podcast:soundbite>
      <podcast:person role="guest" href="https://guest.example">Grace Guest</podcast:person>
      <podcast:season name="The Beginning">1</podcast:season>
      <podcast:alternateEnclosure type="audio/opus" length="999" bitrate="64000" default="false">
        <podcast:source uri="https://cdn.example/ep2.opus"/>
      </podcast:alternateEnclosure>
      <podcast:value type="lightning" method="keysend" suggested="0.00000050000">
        <podcast:valueRecipient name="Episode split" type="lnaddress" address="host@getalby.com" split="100"/>
      </podcast:value>
    </item>
    <item>
      <title>Episode 1</title>
      <guid>ep-1-guid</guid>
      <pubDate>Mon, 01 Jun 2026 08:00:00 GMT</pubDate>
      <itunes:summary>Summary via itunes tag.</itunes:summary>
      <enclosure url="https://cdn.example/ep1.mp3" length="1" type="audio/mpeg"/>
      <itunes:duration>754</itunes:duration>
      <itunes:explicit>yes</itunes:explicit>
    </item>
  </channel>
</rss>`;

describe('parseFeed: Podcasting 1.0 + 2.0', () => {
  const feed = parseFeed(PODCAST_20, { url: URL_ });

  it('detects a podcast and reads channel metadata', () => {
    expect(feed.kind).toBe('podcast');
    expect(feed.title).toBe('Sats & Stories');
    expect(feed.description).toBe('A show about bitcoin & people.');
    expect(feed.imageUrl).toBe('https://podcast.example/cover.jpg');
    expect(feed.author).toBe('Ada Example');
    expect(feed.language).toBe('en-us');
    expect(feed.link).toBe('https://podcast.example/');
    expect(feed.categories).toEqual(expect.arrayContaining(['Technology', 'Podcasting', 'Business']));
  });

  it('reads iTunes (1.0) channel tags', () => {
    expect(feed.podcast).toMatchObject({
      author: 'Ada Example',
      ownerName: 'Ada Owner',
      ownerEmail: 'ada@podcast.example',
      explicit: false,
      showType: 'episodic',
      itunesCategories: ['Technology', 'Podcasting', 'Business'],
      copyright: '© 2026 Example',
    });
  });

  it('reads podcast: namespace (2.0) channel tags', () => {
    const p = feed.podcast!;
    expect(p.guid).toBe('c3a7a1f0-0000-5000-8000-000000000001');
    expect(p.locked).toBe(true);
    expect(p.medium).toBe('podcast');
    expect(p.funding).toEqual([{ url: 'https://podcast.example/support', text: 'Support the show' }]);
    expect(p.persons).toEqual([{ name: 'Ada Example', role: 'host', img: 'https://podcast.example/ada.jpg', href: 'https://ada.example', group: undefined }]);
  });

  it('reads the value block: suggested amount, recipients, custom records and fee flag', () => {
    const v = feed.podcast!.value!;
    expect(v).toMatchObject({ type: 'lightning', method: 'keysend', suggestedSatsPerMinute: 15 });
    expect(v.recipients).toHaveLength(3);
    expect(v.recipients[0]).toMatchObject({ name: 'Show', type: 'node', split: 90 });
    expect(v.recipients[1]).toMatchObject({ customKey: '696969', customValue: 'abc123', split: 5 });
    expect(v.recipients[2]).toMatchObject({ split: 5, fee: true });
  });

  it('returns items newest first with enclosure, duration and episode numbering', () => {
    expect(feed.items.map((i) => i.guid)).toEqual(['ep-2-guid', 'ep-1-guid']);
    const ep2 = feed.items[0]!;
    expect(ep2.title).toBe('Episode 2: Lightning & Podcasts');
    expect(ep2.enclosure).toEqual({ url: 'https://cdn.example/ep2.mp3', type: 'audio/mpeg', length: 12345678 });
    expect(ep2.publishedAt).toBe(Date.UTC(2026, 5, 15, 8));
    expect(ep2.podcast).toMatchObject({ duration: 3723, episode: 2, season: 1, seasonName: 'The Beginning', episodeType: 'full' });
    expect(ep2.imageUrl).toBe('https://podcast.example/ep2.jpg');
    expect(feed.items[1]!.podcast).toMatchObject({ duration: 754, explicit: true });
    expect(feed.items[1]!.summary).toBe('Summary via itunes tag.');
  });

  it('keeps show notes as HTML and the teaser as plain-text summary', () => {
    const ep2 = feed.items[0]!;
    expect(ep2.summary).toBe('Short teaser for episode 2.');
    expect(ep2.contentHtml).toContain('<em>show notes</em>');
  });

  it('reads transcripts (resolving relative URLs), chapters, soundbites, persons and alternate enclosures', () => {
    const p = feed.items[0]!.podcast!;
    expect(p.transcripts).toEqual([
      { url: 'https://podcast.example/transcripts/ep2.vtt', type: 'text/vtt', language: 'en', rel: 'captions' },
      { url: 'https://podcast.example/transcripts/ep2.json', type: 'application/json', language: undefined, rel: undefined },
    ]);
    expect(p.chapters).toEqual({ url: 'https://podcast.example/chapters/ep2.json', type: 'application/json+chapters' });
    expect(p.soundbites).toEqual([{ startTime: 73, duration: 60, title: 'Best bit' }]);
    expect(p.persons[0]).toMatchObject({ name: 'Grace Guest', role: 'guest' });
    expect(p.alternateEnclosures[0]).toMatchObject({ type: 'audio/opus', bitrate: 64000, sources: [{ uri: 'https://cdn.example/ep2.opus' }] });
  });

  it('lets an episode override the channel value block, including lightning-address recipients', () => {
    const v = feed.items[0]!.podcast!.value!;
    expect(v.suggestedSatsPerMinute).toBe(50);
    expect(v.recipients).toEqual([expect.objectContaining({ type: 'lnaddress', address: 'host@getalby.com', split: 100 })]);
    expect(feed.items[1]!.podcast!.value).toBeUndefined();
  });
});

describe('parseFeed: plain Podcasting 1.0 (no podcast: namespace)', () => {
  const rss = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
    <title>Old School</title><link>https://old.example</link><description>Just enclosures.</description>
    <item><title>One</title><guid>1</guid><enclosure url="http://old.example/1.mp3" type="audio/mpeg" length="5"/><itunes:duration>05:30</itunes:duration></item>
    <item><title>Two</title><guid>2</guid><enclosure url="http://old.example/2.mp3" type="audio/mpeg" length="5"/></item>
  </channel></rss>`;
  it('is still a podcast, with no 2.0 extras', () => {
    const f = parseFeed(rss, { url: 'https://old.example/rss' });
    expect(f.kind).toBe('podcast');
    expect(f.items[0]!.podcast).toMatchObject({ duration: 330, transcripts: [], persons: [], soundbites: [] });
    expect(f.podcast?.value).toBeUndefined();
  });
});

describe('parseFeed: namespace prefixes', () => {
  it('rewrites unconventional prefixes bound to the podcast namespace', () => {
    const src = `<rss version="2.0" xmlns:pc="https://podcastindex.org/namespace/1.0" xmlns:it="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
      <title>Odd prefixes</title><link>https://x.example</link><description>d</description>
      <pc:guid>abc</pc:guid><it:author>Someone</it:author>
      <item><title>E</title><guid>e</guid><enclosure url="https://x.example/e.mp3" type="audio/mpeg"/><pc:transcript url="https://x.example/e.srt" type="application/srt"/></item>
    </channel></rss>`;
    const f = parseFeed(src, { url: 'https://x.example/rss' });
    expect(f.podcast?.guid).toBe('abc');
    expect(f.author).toBe('Someone');
    expect(f.items[0]!.podcast!.transcripts[0]!.type).toBe('application/srt');
  });

  it('leaves documents with conventional prefixes untouched', () => {
    expect(normalizePrefixes(PODCAST_20)).toBe(PODCAST_20);
  });
});

describe('parseFeed: article feeds', () => {
  const RSS = `<?xml version="1.0"?>
  <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel>
      <title>Daily News</title><link>https://news.example/</link><description>All the news</description>
      <image><url>https://news.example/logo.png</url></image>
      <item>
        <title><![CDATA[Markets &amp; rates: what happens next]]></title>
        <link>https://news.example/a/markets?utm_source=rss</link>
        <dc:creator>Jo Reporter</dc:creator>
        <pubDate>Tues, 12 Mar 2024 10:00:00 GMT</pubDate>
        <description>&lt;p&gt;Central banks &lt;b&gt;held&lt;/b&gt; rates steady.&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;</description>
        <content:encoded><![CDATA[<p>Full story text. <img src="/img/chart.png"></p><script>alert(1)</script>]]></content:encoded>
        <media:thumbnail url="https://news.example/thumb.jpg"/>
        <category>Economy</category><category>Markets</category>
      </item>
      <item><title>No guid, no date</title><link>https://news.example/a/second</link><description>Plain text only.</description></item>
    </channel>
  </rss>`;
  const f = parseFeed(RSS, { url: 'https://news.example/rss' });

  it('is an article feed', () => {
    expect(f.kind).toBe('article');
    expect(f.podcast).toBeUndefined();
    expect(f.imageUrl).toBe('https://news.example/logo.png');
  });

  it('extracts title, author, categories, tolerant date and a script-free plain-text summary', () => {
    const a = f.items.find((i) => i.link?.includes('markets'))!;
    expect(a.title).toBe('Markets & rates: what happens next');
    expect(a.author).toBe('Jo Reporter');
    expect(a.categories).toEqual(['Economy', 'Markets']);
    expect(a.publishedAt).toBe(Date.UTC(2024, 2, 12, 10));
    expect(a.summary).toBe('Central banks held rates steady.');
    expect(a.summary).not.toContain('alert');
    expect(a.imageUrl).toBe('https://news.example/thumb.jpg');
  });

  it('keeps the raw content HTML (sanitised later by the client) and falls back sensibly for missing guid/date', () => {
    const a = f.items.find((i) => i.link?.includes('markets'))!;
    expect(a.contentHtml).toContain('Full story text.');
    const b = f.items.find((i) => i.link?.includes('second'))!;
    expect(b.guid).toBe('https://news.example/a/second');
    expect(b.publishedAt).toBeUndefined();
    expect(b.contentHtml).toBeUndefined();
  });
});

describe('parseFeed: Atom', () => {
  const ATOM = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
    <title>Atom Blog</title><subtitle>Thoughts</subtitle>
    <link rel="self" href="https://blog.example/atom.xml"/><link rel="alternate" href="https://blog.example/"/>
    <author><name>Blog Author</name></author>
    <entry>
      <title type="html">Post &amp;amp; one</title>
      <link rel="alternate" href="/posts/one"/>
      <id>tag:blog.example,2026:1</id>
      <published>2026-03-01T10:00:00Z</published><updated>2026-03-02T10:00:00Z</updated>
      <summary>Summary of post one.</summary>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Body of post one.</p></div></content>
      <category term="meta"/>
      <link rel="enclosure" type="audio/mpeg" href="https://blog.example/one.mp3" length="10"/>
    </entry>
  </feed>`;
  const f = parseFeed(ATOM, { url: 'https://blog.example/atom.xml' });
  it('parses Atom entries', () => {
    expect(f.title).toBe('Atom Blog');
    expect(f.link).toBe('https://blog.example/');
    expect(f.author).toBe('Blog Author');
    const e = f.items[0]!;
    expect(e.guid).toBe('tag:blog.example,2026:1');
    expect(e.title).toBe('Post & one');
    expect(e.link).toBe('https://blog.example/posts/one');
    expect(e.publishedAt).toBe(Date.UTC(2026, 2, 1, 10));
    expect(e.summary).toBe('Summary of post one.');
    expect(e.categories).toEqual(['meta']);
    expect(e.enclosure?.url).toBe('https://blog.example/one.mp3');
  });
});

describe('parseFeed: RSS 1.0 (RDF)', () => {
  it('reads channel and items that are siblings of the channel', () => {
    const rdf = `<?xml version="1.0"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="https://rdf.example/"><title>RDF Site</title><link>https://rdf.example/</link><description>Old school</description></channel>
      <item rdf:about="https://rdf.example/1"><title>First</title><link>https://rdf.example/1</link><description>Hello</description><dc:date>2025-05-05T05:05:05Z</dc:date></item>
    </rdf:RDF>`;
    const f = parseFeed(rdf, { url: 'https://rdf.example/rss' });
    expect(f.title).toBe('RDF Site');
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ title: 'First', link: 'https://rdf.example/1', publishedAt: Date.UTC(2025, 4, 5, 5, 5, 5) });
  });
});

describe('parseFeed: JSON Feed', () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON Show',
    home_page_url: 'https://json.example/',
    items: [
      { id: '1', url: 'https://json.example/1', title: 'Ep', content_html: '<p>Notes</p>', date_published: '2026-01-02T03:04:05Z', attachments: [{ url: 'https://json.example/1.mp3', mime_type: 'audio/mpeg', duration_in_seconds: 90 }] },
    ],
  });
  it('parses items and detects podcasts from audio attachments', () => {
    const f = parseFeed(json, { url: 'https://json.example/feed.json' });
    expect(f.kind).toBe('podcast');
    expect(f.items[0]).toMatchObject({ guid: '1', title: 'Ep', summary: 'Notes', enclosure: { url: 'https://json.example/1.mp3' } });
    expect(f.items[0]!.podcast?.duration).toBe(90);
  });
  it('rejects JSON that is not a feed', () => {
    expect(() => parseFeed('{"hello":1}', { url: 'https://x.example/' })).toThrow(/JSON Feed/);
  });
});

describe('parseFeed: robustness', () => {
  it('rejects HTML and other non-feeds with a helpful error', () => {
    expect(() => parseFeed('<!doctype html><html><body>hi</body></html>', { url: 'https://x.example/' })).toThrow(/does not look like/);
    expect(() => parseFeed('', { url: 'https://x.example/' })).toThrow();
  });

  it('keeps only the newest N items', () => {
    const items = Array.from({ length: 10 }, (_, i) => `<item><title>T${i}</title><guid>g${i}</guid><pubDate>Mon, ${String(i + 1).padStart(2, '0')} Jun 2026 00:00:00 GMT</pubDate></item>`).join('');
    const f = parseFeed(`<rss version="2.0"><channel><title>x</title>${items}</channel></rss>`, { url: 'https://x.example/', limit: 3 });
    expect(f.items.map((i) => i.guid)).toEqual(['g9', 'g8', 'g7']);
  });

  it('makes duplicate guids unique so every episode can be stored', () => {
    const f = parseFeed(`<rss version="2.0"><channel><title>x</title><item><title>A</title><guid>same</guid></item><item><title>B</title><guid>same</guid></item></channel></rss>`, { url: 'https://x.example/' });
    expect(new Set(f.items.map((i) => i.guid)).size).toBe(2);
  });

  it('survives a UTF-8 BOM, a single item (not an array) and missing channel fields', () => {
    const f = parseFeed('﻿<rss version="2.0"><channel><item><title>Only</title></item></channel></rss>', { url: 'https://x.example/feed' });
    expect(f.title).toBe('x.example');
    expect(f.items).toHaveLength(1);
  });

  it('does not expand entity bombs', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">]><rss version="2.0"><channel><title>&lol4;</title><item><title>x</title></item></channel></rss>`;
    const start = performance.now();
    try {
      const f = parseFeed(bomb, { url: 'https://x.example/' });
      expect(f.title.length).toBeLessThan(10_000);
    } catch {
      // rejecting it is fine too
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('parseDate', () => {
  it('handles RFC 822, ISO 8601 and bad weekday names; rejects nonsense', () => {
    expect(parseDate('Mon, 15 Jun 2026 08:00:00 GMT')).toBe(Date.UTC(2026, 5, 15, 8));
    expect(parseDate('2026-06-15T08:00:00+02:00')).toBe(Date.UTC(2026, 5, 15, 6));
    expect(parseDate('Tues, 12 Mar 2024 10:00:00 GMT')).toBe(Date.UTC(2024, 2, 12, 10));
    expect(parseDate('yesterday')).toBeUndefined();
    expect(parseDate('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });
});
