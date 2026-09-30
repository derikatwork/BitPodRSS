import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractArticle, extractFromHtml } from './article';
import { decodeBody } from './charset';
import { discoverFeedLinks, fetchFeed } from './feed/fetch';
import { htmlToText } from './html';

const PAGE = `<!doctype html><html lang="en"><head><title>Test Story | Example News</title>
<meta property="og:site_name" content="Example News"><meta property="article:published_time" content="2026-03-01T10:00:00Z">
<meta name="author" content="Jo Reporter"></head><body>
<nav><a href="/home">Home</a><a href="/about">About</a></nav>
<article><h1>Test Story</h1><p class="byline">By Jo Reporter</p>
<p>This is the first paragraph of a reasonably long article about something important that happened today in the world of technology and finance, and it needs enough text for the extractor to be confident.</p>
<p>Second paragraph with a <a href="/related/story">relative link</a> and a <a href="javascript:alert(1)">bad link</a> and more words to pad the content so that scoring picks it up as the main body of the page rather than navigation.</p>
<img src="/img/photo.jpg" alt="photo">
<p>Third paragraph continues the story with yet more words, because readability heuristics look at paragraph length and comma counts, which we are providing here, in abundance, honestly.</p>
<script>alert(1)</script></article>
<footer>Copyright</footer></body></html>`;

describe('htmlToText', () => {
  it('keeps paragraph breaks, drops scripts and decodes entities', () => {
    expect(htmlToText('<p>One &amp; two</p><script>x()</script><p>Three<br>four</p>')).toBe('One & two\n\nThree\nfour');
  });
  it('passes plain text through', () => {
    expect(htmlToText('just  text')).toBe('just text');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('decodeBody', () => {
  it('honours the Content-Type charset', () => {
    expect(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/xml; charset=ISO-8859-1')).toBe('café');
  });
  it('falls back to the XML declaration, then UTF-8', () => {
    const latin1 = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><t>'), Buffer.from([0xe9]), Buffer.from('</t>')]);
    expect(decodeBody(latin1)).toContain('é');
    expect(decodeBody(Buffer.from('héllo', 'utf8'))).toBe('héllo');
  });
  it('ignores unknown charset labels', () => {
    expect(decodeBody(Buffer.from('ok'), 'text/html; charset=bogus-9000')).toBe('ok');
  });
});

describe('extractFromHtml', () => {
  const a = extractFromHtml(PAGE, 'https://news.example/2026/story');
  it('extracts title (without the site suffix), byline, site and date', () => {
    expect(a.title).toBe('Test Story');
    expect(a.byline).toBe('Jo Reporter');
    expect(a.siteName).toBe('Example News');
    expect(a.lang).toBe('en');
    expect(a.publishedAt).toBe(Date.UTC(2026, 2, 1, 10));
  });
  it('returns clean body text without navigation, scripts or the duplicated byline', () => {
    expect(a.text).toContain('first paragraph of a reasonably long article');
    expect(a.text).toContain('Third paragraph');
    expect(a.text).not.toContain('Home');
    expect(a.text).not.toContain('alert');
    expect(a.text).not.toMatch(/^By Jo Reporter/);
  });
  it('makes links and images absolute and removes unsafe link schemes', () => {
    expect(a.contentHtml).toContain('href="https://news.example/related/story"');
    expect(a.contentHtml).toContain('src="https://news.example/img/photo.jpg"');
    expect(a.contentHtml).not.toContain('javascript:');
  });
  it('fails clearly when there is nothing readable', () => {
    expect(() => extractFromHtml('<html><body><p>hi</p></body></html>', 'https://x.example/')).toThrow(/readable/);
  });
});

describe('discoverFeedLinks', () => {
  it('finds alternate feed links in any attribute order and resolves them', () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link href='https://x.example/atom' type='application/atom+xml' rel='alternate'>
      <link rel="stylesheet" href="/a.css">
      <link rel="alternate" type="text/html" href="/fr/">
    </head>`;
    expect(discoverFeedLinks(html, 'https://x.example/blog/')).toEqual(['https://x.example/feed.xml', 'https://x.example/atom']);
  });
});

describe('network: fetchFeed and extractArticle', () => {
  let server: http.Server;
  let base: string;
  const RSS = (title: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><item><title>Hi</title><guid>1</guid></item></channel></rss>`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/feed.xml') {
        if (req.headers['if-none-match'] === '"v1"') return void res.writeHead(304).end();
        res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"', 'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT' }).end(RSS('Direct feed'));
      } else if (url === '/site') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Hello</body></html>');
      } else if (url === '/no-feed') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head></head><body>Nothing here</body></html>');
      } else if (url === '/latin1') {
        const body = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></channel></rss>')]);
        res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
      } else if (url === '/article') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      } else if (url === '/image.png') {
        res.writeHead(200, { 'content-type': 'image/png' }).end('x');
      } else if (url === '/boom') {
        res.writeHead(500).end('boom');
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  afterEach(() => vi.unstubAllEnvs());
  const allow = () => vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');

  it('fetches a feed and records its validators', async () => {
    allow();
    const f = await fetchFeed(`${base}/feed.xml`);
    expect('notModified' in f).toBe(false);
    if ('notModified' in f) return;
    expect(f.title).toBe('Direct feed');
    expect(f.etag).toBe('"v1"');
    expect(f.lastModified).toBe('Mon, 01 Jun 2026 00:00:00 GMT');
  });

  it('returns notModified when the validators still match', async () => {
    allow();
    expect(await fetchFeed(`${base}/feed.xml`, { etag: '"v1"' })).toEqual({ notModified: true });
  });

  it('follows a web page to the feed it advertises', async () => {
    allow();
    const f = await fetchFeed(`${base}/site`);
    expect('title' in f && f.title).toBe('Direct feed');
  });

  it('explains when a page has no feed, and when the server errors', async () => {
    allow();
    await expect(fetchFeed(`${base}/no-feed`)).rejects.toMatchObject({ status: 422, message: /does not advertise/ });
    await expect(fetchFeed(`${base}/boom`)).rejects.toMatchObject({ status: 502, message: /HTTP 500/ });
  });

  it('decodes non-UTF-8 feeds', async () => {
    allow();
    const f = await fetchFeed(`${base}/latin1`);
    expect('title' in f && f.title).toBe('Café');
  });

  it('extracts an article from a URL and rejects non-pages', async () => {
    allow();
    const a = await extractArticle(`${base}/article`);
    expect(a.title).toBe('Test Story');
    expect(a.contentHtml).toContain(`src="${base}/img/photo.jpg"`);
    await expect(extractArticle(`${base}/image.png`)).rejects.toMatchObject({ status: 415 });
  });

  it('refuses private targets unless explicitly allowed', async () => {
    await expect(fetchFeed(`${base}/feed.xml`)).rejects.toMatchObject({ status: 403 });
  });
});
