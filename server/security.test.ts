import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpError, assertAllowedUrl, hostGuard, hostOf, isBlockedAddress, safeFetch } from './security';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::7f00:1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
  it('blocks things that are not IP addresses', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
});

describe('assertAllowedUrl', () => {
  it('rejects non-http schemes, credentials and malformed input', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://x', 'not a url', 'https://user:pw@example.com/']) {
      expect(() => assertAllowedUrl(bad, false), bad).toThrow(HttpError);
    }
  });
  it('rejects literal private addresses in every spelling the URL parser normalises', () => {
    for (const bad of ['http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:7f00:1]/']) {
      expect(() => assertAllowedUrl(bad, false), bad).toThrow(/private|reserved/);
    }
  });
  it('accepts public URLs and, when allowed, private ones', () => {
    expect(assertAllowedUrl('https://example.com/feed.xml', false).hostname).toBe('example.com');
    expect(assertAllowedUrl('http://192.168.1.10/feed', true).hostname).toBe('192.168.1.10');
  });
});

describe('hostOf', () => {
  it('strips ports and brackets', () => {
    expect(hostOf('localhost:8787')).toBe('localhost');
    expect(hostOf('[::1]:8787')).toBe('::1');
    expect(hostOf('Example.COM')).toBe('example.com');
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('content-type', 'text/plain');
        res.end('hello');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(2048, 97));
      } else if (req.url === '/slow') {
        // never answers
      } else {
        res.writeHead(404).end('nope');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses loopback targets by default, by IP and by name', async () => {
    await expect(safeFetch(`${base}/ok`)).rejects.toMatchObject({ status: 403 });
    const port = new URL(base).port;
    await expect(safeFetch(`http://localhost:${port}/ok`)).rejects.toMatchObject({ status: 403 });
  });

  it('fetches, follows redirects and reports the final URL when private networks are allowed', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    const res = await safeFetch(`${base}/redirect`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello');
    expect(res.url).toBe(`${base}/ok`);
  });

  it('gives up on redirect loops', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    await expect(safeFetch(`${base}/loop`, { maxRedirects: 3 })).rejects.toMatchObject({ status: 502, message: /redirects/ });
  });

  it('enforces the size limit', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    await expect(safeFetch(`${base}/big`, { maxBytes: 1024 })).rejects.toMatchObject({ status: 413 });
  });

  it('times out slow servers', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    await expect(safeFetch(`${base}/slow`, { timeoutMs: 200 })).rejects.toMatchObject({ status: 504 });
  });

  it('passes error statuses through for the caller to interpret', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    expect((await safeFetch(`${base}/missing`)).status).toBe(404);
  });
});

describe('hostGuard', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    const app = express();
    app.use(hostGuard(['myhost.lan']));
    app.get('/', (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const get = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).on('error', reject);
    });

  it('allows local and configured hosts', async () => {
    expect(await get({ host: `localhost:${port}` })).toBe(200);
    expect(await get({ host: `127.0.0.1:${port}` })).toBe(200);
    expect(await get({ host: `myhost.lan:${port}` })).toBe(200);
  });
  it('rejects DNS-rebinding style hosts and foreign origins', async () => {
    expect(await get({ host: `evil.example:${port}` })).toBe(403);
    expect(await get({ host: `localhost:${port}`, origin: 'https://evil.example' })).toBe(403);
    expect(await get({ host: `localhost:${port}`, origin: 'http://localhost:5173' })).toBe(200);
  });
});
