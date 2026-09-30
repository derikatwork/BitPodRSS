import dns from 'node:dns';
import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { Agent, fetch as undiciFetch } from 'undici';

/** Error carrying the HTTP status the API should answer with. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// ---------------------------------------------------------------------------------------------
// Address filtering (SSRF protection)
// ---------------------------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96], // NAT64: can wrap a private IPv4 address
  ['2002::', 16], // 6to4
  ['2001::', 32], // Teredo
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse rather than guess
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = (addresses as dns.LookupAddress[]).filter((a) => !isBlockedAddress(a.address));
    if (list.length === 0) {
      return callback(new HttpError(403, `Refusing to connect to a private or reserved address (${hostname})`), []);
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

// One agent resolves via the guarded lookup above; the other is unrestricted (ALLOW_PRIVATE_NETWORK=1).
// Checking at connect time, rather than before, closes the DNS-rebinding window.
const guardedAgent = new Agent({ connect: { lookup: guardedLookup as never, timeout: 10_000 } });
const openAgent = new Agent({ connect: { timeout: 10_000 } });

export function allowPrivateNetwork(): boolean {
  return process.env['ALLOW_PRIVATE_NETWORK'] === '1';
}

/** Validate scheme, credentials and literal IP hosts. DNS names are checked again at connect time. */
export function assertAllowedUrl(input: string, allowPrivate = allowPrivateNetwork()): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http and https URLs are supported');
  if (url.username || url.password) throw new HttpError(400, 'URLs with embedded credentials are not supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && isBlockedAddress(host)) {
    throw new HttpError(403, 'Refusing to connect to a private or reserved address');
  }
  return url;
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

export const USER_AGENT = 'BitPodRSS/0.1 (+https://github.com/derikatwork/BitPodRSS)';

export interface SafeFetchOptions {
  /** Abort if the body exceeds this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** Abort the whole request after this long. Default 20 s. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  body: Buffer;
}

export interface SafeStream {
  status: number;
  url: string;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

async function request(url: string, opts: SafeFetchOptions): Promise<{ res: Awaited<ReturnType<typeof undiciFetch>>; url: string }> {
  const allowPrivate = allowPrivateNetwork();
  const dispatcher = allowPrivate ? openAgent : guardedAgent;
  const maxRedirects = opts.maxRedirects ?? 5;
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 20_000)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);

  let current = assertAllowedUrl(url, allowPrivate).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await undiciFetch(current, {
        dispatcher,
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br', ...opts.headers },
      });
    } catch (err) {
      throw translateFetchError(err, signal);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      current = assertAllowedUrl(new URL(res.headers.get('location')!, current).toString(), allowPrivate).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new HttpError(502, 'Too many redirects');
}

function translateFetchError(err: unknown, signal: AbortSignal): HttpError {
  if (err instanceof HttpError) return err;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof HttpError) return cause;
  if (signal.aborted) return new HttpError(504, 'The remote server took too long to respond');
  const code = (cause as { code?: string } | undefined)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new HttpError(502, 'Could not resolve the host name');
  if (code === 'ECONNREFUSED') return new HttpError(502, 'Connection refused by the remote server');
  return new HttpError(502, `Could not fetch URL${code ? ` (${code})` : ''}`);
}

/** Fetch a URL and buffer the body, refusing private targets, oversized bodies and slow servers. */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const { res, url: finalUrl } = await request(url, opts);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(413, `Response is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(413, `Response is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'The connection was interrupted while downloading');
    }
  }
  return { status: res.status, url: finalUrl, headers: res.headers as unknown as Headers, body: Buffer.concat(chunks) };
}

/** Like {@link safeFetch} but hands back the body stream (for large media). The caller enforces size limits. */
export async function safeFetchStream(url: string, opts: SafeFetchOptions = {}): Promise<SafeStream> {
  const { res, url: finalUrl } = await request(url, opts);
  if (!res.body) throw new HttpError(502, 'The remote server sent no content');
  return { status: res.status, url: finalUrl, headers: res.headers as unknown as Headers, body: res.body as unknown as ReadableStream<Uint8Array> };
}

// ---------------------------------------------------------------------------------------------
// Inbound request protection
// ---------------------------------------------------------------------------------------------

/** Host header without the port: "localhost:8787" -> "localhost", "[::1]:8787" -> "::1". */
export function hostOf(value: string): string {
  const v = value.toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end) : v;
  }
  return v.replace(/:\d+$/, '');
}

/**
 * Only answer requests addressed to a trusted host name. Stops a malicious web page from using
 * DNS rebinding to talk to this local server as if it were its own origin.
 */
export function hostGuard(extraHosts: readonly string[] = []) {
  const allowed = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts.map((h) => h.toLowerCase())]);
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = hostOf(req.headers.host ?? '');
    if (!allowed.has(host)) {
      res.status(403).json({ error: `Host "${host}" is not allowed. Set ALLOWED_HOSTS to permit it.` });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        // fallthrough: empty host is rejected below
      }
      if (!allowed.has(originHost)) {
        res.status(403).json({ error: 'Cross-origin requests are not allowed' });
        return;
      }
    }
    next();
  };
}
