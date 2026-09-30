import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { BtcService } from './btc';
import { TranscriptionService } from './transcribe/service';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 12);

const FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Fixture Show</title><link>https://show.example</link><description>d</description>
<item><title>Ep</title><guid>g1</guid><enclosure url="https://cdn.example/e.mp3" type="audio/mpeg" length="1"/><podcast:transcript url="/t.vtt" type="text/vtt"/></item></channel></rss>`;

const ARTICLE = `<!doctype html><html lang="en"><head><title>Story | Site</title><meta property="og:site_name" content="Site"></head><body><article><h1>Story</h1>
<p>${'This is a long enough paragraph of article text to be recognised as content by the extractor. '.repeat(4)}</p>
<p>${'Second paragraph adds more words, commas, and substance so scoring is stable for the test run. '.repeat(3)}</p></article></body></html>`;

describe('HTTP API', () => {
  let upstream: http.Server;
  let upstreamBase: string;
  let api: http.Server;
  let base: string;
  let dataDir: string;
  let staticDir: string;

  beforeAll(async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpod-api-'));
    staticDir = path.join(dataDir, 'dist');
    fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
    fs.writeFileSync(path.join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');

    upstream = http.createServer((req, res) => {
      const routes: Record<string, [string, string]> = {
        '/feed.xml': ['application/rss+xml', FEED],
        '/article': ['text/html', ARTICLE],
        '/t.vtt': ['text/vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello'],
        '/chapters.json': ['application/json', '{"version":"1.2.0","chapters":[{"startTime":0,"title":"Intro"}]}'],
        '/pic.png': ['image/png', 'PNG'],
      };
      const hit = routes[req.url ?? ''];
      if (hit) res.writeHead(200, { 'content-type': hit[0] }).end(hit[1]);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const btc = new BtcService({
      now: () => NOW,
      fetchJson: async (url) => {
        const days = Number(new URL(url).searchParams.get('days'));
        const step = days > 90 ? DAY : 3_600_000;
        const prices: [number, number][] = [];
        for (let t = NOW - days * DAY; t <= NOW; t += step) prices.push([t, 60_000]);
        return { prices };
      },
    });
    const transcription = new TranscriptionService({
      dataDir,
      loadAsr: async () => async () => [{ start: 0, end: 2, text: 'hello world' }],
      download: async (_u, dest) => {
        fs.writeFileSync(dest, 'x');
        return 1;
      },
      decode: async function* () {
        yield new Float32Array(16_000 * 3);
      },
      ffmpegAvailable: () => true,
      maxAudioBytes: 1e6,
    });

    api = http.createServer(createApp({ dataDir, staticDir, btc, transcription, allowedHosts: [] }));
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://localhost:${(api.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    upstream.closeAllConnections();
    api.closeAllConnections();
    upstream.close();
    api.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  afterEach(() => undefined);

  const json = async (p: string, init?: RequestInit) => {
    const res = await fetch(base + p, init);
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any, headers: res.headers };
  };

  it('health', async () => {
    expect((await json('/api/health')).body).toEqual({ ok: true });
  });

  it('GET /api/feed parses a Podcasting 2.0 feed', async () => {
    const r = await json(`/api/feed?url=${encodeURIComponent(upstreamBase + '/feed.xml')}`);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('podcast');
    expect(r.body.items[0].podcast.transcripts[0].url).toBe(`${upstreamBase}/t.vtt`);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('validates input with useful status codes', async () => {
    expect((await json('/api/feed')).status).toBe(400);
    expect((await json('/api/feed?url=not-a-url')).status).toBe(400);
    expect((await json('/api/feed?url=file:///etc/passwd')).status).toBe(400);
    expect((await json(`/api/feed?url=${encodeURIComponent(upstreamBase + '/missing')}`)).status).toBe(502);
    expect((await json('/api/nope')).status).toBe(404);
  });

  it('refuses private targets when private networks are not allowed', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '0');
    const r = await json(`/api/feed?url=${encodeURIComponent(upstreamBase + '/feed.xml')}`);
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    expect(r.status).toBe(403);
  });

  it('GET /api/article extracts readable content', async () => {
    const r = await json(`/api/article?url=${encodeURIComponent(upstreamBase + '/article')}`);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Story');
    expect(r.body.text).toContain('long enough paragraph');
  });

  it('GET /api/proxy relays text but not binary types, always as inert text/plain', async () => {
    const vtt = await fetch(`${base}/api/proxy?url=${encodeURIComponent(upstreamBase + '/t.vtt')}`);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await vtt.text()).toContain('WEBVTT');
    expect((await json(`/api/proxy?url=${encodeURIComponent(upstreamBase + '/pic.png')}`)).status).toBe(415);
  });

  it('GET /api/btc returns price history and rejects bad currencies', async () => {
    const r = await json('/api/btc?currency=usd');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ currency: 'usd', current: 60_000, source: 'coingecko' });
    expect((await json('/api/btc?currency=nope')).status).toBe(400);
  });

  it('transcription: start, poll, and cancel', async () => {
    const start = await json('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://cdn.example/e.mp3', model: 'Xenova/whisper-tiny.en', durationSec: 3 }),
    });
    expect(start.status).toBe(202);
    const id = start.body.id as string;
    let state = start.body;
    for (let i = 0; i < 100 && state.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = (await json(`/api/transcribe/${id}`)).body;
    }
    expect(state.status).toBe('done');
    expect(state.segments[0]).toMatchObject({ text: 'hello world', start: 0 });

    expect((await json('/api/transcribe/unknown')).status).toBe(404);
    expect((await fetch(`${base}/api/transcribe/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/api/transcribe/unknown`, { method: 'DELETE' })).status).toBe(404);
  });

  it('transcription rejects malformed requests', async () => {
    const post = (body: string, type = 'application/json') => json('/api/transcribe', { method: 'POST', headers: { 'content-type': type }, body });
    expect((await post('{bad json')).status).toBe(400);
    expect((await post('{}')).status).toBe(400);
    expect((await post(JSON.stringify({ url: 'https://x.example/a.mp3', model: 'evil/model' }))).status).toBe(400);
    expect((await post('url=x', 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await post(JSON.stringify({ url: 'x'.repeat(40_000) }))).status).toBe(413);
  });

  it('GET /api/capabilities reports models and ffmpeg', async () => {
    const r = await json('/api/capabilities');
    expect(r.body.ffmpeg.available).toBe(true);
    expect(r.body.whisper.models.length).toBeGreaterThan(3);
    expect(r.body.defaultModel).toMatch(/whisper/);
  });

  it('rejects requests for unknown Host headers (DNS rebinding)', async () => {
    const port = (api.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `attacker.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('serves the built client with a CSP and falls back to index.html for client routes', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await root.text()).toContain('id="root"');
    const deep = await fetch(`${base}/podcasts/123`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('id="root"');
    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    // Unknown API routes must stay JSON, not fall through to the SPA.
    expect((await fetch(`${base}/api/unknown`)).headers.get('content-type')).toMatch(/json/);
  });
});
