import http from 'node:http';
import type { AddressInfo } from 'node:net';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toUTCString();
const isoHoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const STORY_SUMMARY =
  'The Federal Reserve left its benchmark interest rate unchanged on Wednesday as policymakers weighed stubborn inflation against a cooling labor market, and signalled that cuts could come later this year if prices keep easing.';

const ARTICLE_BODY = (n: string) => `<p>${`Paragraph about ${n}. This text is long enough for the readability extractor to treat it as the main article content, with commas, clauses, and plenty of words. `.repeat(3)}</p><p>${`More detail about ${n} follows here, adding further sentences so the extractive summary has something to choose from. `.repeat(3)}</p>`;

/** Two wire services carrying the same story (plus unrelated ones), so duplicate detection has work to do. */
export function feeds(base: string) {
  const wireA = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Wire One</title><link>${base}/wire-one</link><description>News wire one</description>
  <item><title>Fed holds interest rates steady amid inflation worries - Wire One</title><link>${base}/articles/fed?utm_source=rss</link><guid>w1-fed</guid><pubDate>${hoursAgo(5)}</pubDate><description>${STORY_SUMMARY}</description><content:encoded><![CDATA[${ARTICLE_BODY('the Fed decision')}]]></content:encoded></item>
  <item><title>Local bakery wins national sourdough award</title><link>${base}/articles/bakery</link><guid>w1-bakery</guid><pubDate>${hoursAgo(9)}</pubDate><description>A small neighborhood bakery took home the top prize at the national baking championship after judges praised its crusty sourdough loaf and inventive pastries.</description></item>
  <item><title>Chipmaker unveils new data center processor</title><link>${base}/articles/chip</link><guid>w1-chip</guid><pubDate>${hoursAgo(20)}</pubDate><description>The company says its new processor doubles performance per watt for AI training workloads.</description></item>
  </channel></rss>`;

  const wireB = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Wire Two</title><link>${base}/wire-two</link><description>News wire two</description>
  <item><title>Fed holds interest rates steady amid inflation worries | Wire Two</title><link>${base}/other/fed-story</link><guid>w2-fed</guid><pubDate>${hoursAgo(4)}</pubDate><description>${STORY_SUMMARY} Markets reacted calmly.</description></item>
  <item><title>Marathon record falls in windy Berlin race</title><link>${base}/other/marathon</link><guid>w2-marathon</guid><pubDate>${hoursAgo(11)}</pubDate><description>A runner shaved nearly a minute off the world best despite gusty conditions on the course.</description></item>
  <item><title>Chipmaker unveils new data center processor</title><link>${base}/articles/chip?utm_campaign=x</link><guid>w2-chip</guid><pubDate>${hoursAgo(19)}</pubDate><description>Different summary text entirely, written by another editor.</description></item>
  </channel></rss>`;

  const blog = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A Personal Blog</title><link rel="alternate" href="${base}/blog"/>
  <entry><title>Thoughts on running your own node</title><link rel="alternate" href="${base}/blog/node"/><id>blog-node</id><published>${isoHoursAgo(30)}</published><summary>Why I run a node at home and what it taught me about self-custody.</summary></entry></feed>`;

  const podcast = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
  <title>Sats &amp; Stories</title><link>${base}/show</link><description>A fixture podcast about bitcoin.</description>
  <itunes:author>Ada Example</itunes:author><itunes:image href="${base}/cover.svg"/><itunes:category text="Technology"/>
  <podcast:guid>c3a7a1f0-0000-5000-8000-000000000001</podcast:guid>
  <podcast:funding url="${base}/support">Support the show</podcast:funding>
  <podcast:value type="lightning" method="keysend" suggested="0.00000015000">
    <podcast:valueRecipient name="Show" type="node" address="02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" split="95"/>
    <podcast:valueRecipient name="App" type="node" address="03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" split="5" fee="true"/>
  </podcast:value>
  <item><title>Episode 2: Lightning and Podcasts</title><guid>ep-2</guid><pubDate>${hoursAgo(6)}</pubDate><description>Episode two show notes.</description>
    <enclosure url="${base}/audio.wav" length="320044" type="audio/wav"/><itunes:duration>10</itunes:duration><itunes:episode>2</itunes:episode>
    <podcast:transcript url="${base}/t.vtt" type="text/vtt"/><podcast:chapters url="${base}/chapters.json" type="application/json+chapters"/>
    <podcast:person role="guest" href="${base}/guest">Grace Guest</podcast:person></item>
  <item><title>Episode 3: The Long One</title><guid>ep-3</guid><pubDate>${hoursAgo(1)}</pubDate><description>A longer episode.</description>
    <enclosure url="${base}/long.wav" length="2080044" type="audio/wav"/><itunes:duration>65</itunes:duration><itunes:episode>3</itunes:episode></item>
  <item><title>Episode 1: Beginnings</title><guid>ep-1</guid><pubDate>${hoursAgo(200)}</pubDate><description>Episode one show notes.</description>
    <enclosure url="${base}/audio.wav" length="320044" type="audio/wav"/><itunes:duration>10</itunes:duration><itunes:episode>1</itunes:episode></item>
  </channel></rss>`;

  const evil = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Hostile Feed</title><link>${base}/evil</link><description>Tries to run script</description>
  <item><title>Innocent looking post</title><link>${base}/articles/evil</link><guid>evil-1</guid><pubDate>${hoursAgo(2)}</pubDate>
  <description>Click here</description>
  <content:encoded><![CDATA[<p>Hello</p><img src="x" onerror="window.__xss='img-onerror'"><script>window.__xss='script-tag'</script><a href="javascript:window.__xss='js-link'">click me</a><iframe src="${base}/articles/evil"></iframe><form action="https://evil.example"><input name="pw"></form><style>body{display:none}</style><svg onload="window.__xss='svg'"></svg>]]></content:encoded></item>
  </channel></rss>`;

  return { wireA, wireB, blog, podcast, evil };
}

/** 10 seconds of 16 kHz mono 16-bit PCM (quiet 220 Hz tone) as a WAV file. */
export function makeWav(seconds = 10): Buffer {
  const rate = 16_000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}

const VTT = `WEBVTT

00:00:00.500 --> 00:00:03.000
<v Ada>Welcome to Sats and Stories.

00:00:03.000 --> 00:00:06.000
<v Grace>Thanks, glad to be here.

00:00:06.000 --> 00:00:09.500
<v Ada>Let's talk about the lightning network.
`;

const CHAPTERS = JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 4, title: 'Lightning deep dive' }, { startTime: 8, title: 'Wrap up' }] });

export interface Fixtures {
  base: string;
  close: () => Promise<void>;
}

export async function startFixtures(): Promise<Fixtures> {
  const shortWav = makeWav();
  const longWav = makeWav(65);
  let base = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const f = feeds(base);
    const send = (type: string, body: string | Buffer) => res.writeHead(200, { 'content-type': type }).end(body);
    switch (url.pathname) {
      case '/wire-one.xml': return send('application/rss+xml', f.wireA);
      case '/wire-two.xml': return send('application/rss+xml', f.wireB);
      case '/blog.atom': return send('application/atom+xml', f.blog);
      case '/podcast.xml': return send('application/rss+xml', f.podcast);
      case '/evil.xml': return send('application/rss+xml', f.evil);
      case '/t.vtt': return send('text/vtt', VTT);
      case '/chapters.json': return send('application/json', CHAPTERS);
      case '/cover.svg': return send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2a78d6"/></svg>');
      case '/audio.wav':
      case '/long.wav': {
        const wav = url.pathname === '/long.wav' ? longWav : shortWav;
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
          res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
          return void res.end(wav.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length });
        return void res.end(wav);
      }
      default: {
        if (url.pathname.startsWith('/articles/') || url.pathname.startsWith('/other/') || url.pathname.startsWith('/blog/')) {
          const title = url.pathname.split('/').pop()!;
          return send('text/html', `<!doctype html><html lang="en"><head><title>${title} | Fixture News</title><meta property="og:site_name" content="Fixture News"></head><body><article><h1>${title}</h1>${ARTICLE_BODY(title)}</article></body></html>`);
        }
        res.writeHead(404).end('not found');
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
