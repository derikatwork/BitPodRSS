import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { extractArticle } from './article';
import { BtcService } from './btc';
import { decodeBody } from './charset';
import { fetchFeed } from './feed/fetch';
import { HttpError, hostGuard, safeFetch } from './security';
import { DEFAULT_MODEL } from './transcribe/models';
import { TranscriptionService, defaultDeps } from './transcribe/service';

export interface AppConfig {
  /** Directory for models, cached transcripts and temp audio. */
  dataDir: string;
  /** Extra Host header values to accept (besides localhost). */
  allowedHosts?: string[];
  /** Built client (Vite `dist`). When present it is served at `/`. */
  staticDir?: string;
  btc?: BtcService;
  transcription?: TranscriptionService;
}

function query(req: Request, name: string): string {
  const v = req.query[name];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `Missing "${name}" parameter`);
  return v.trim();
}

function optionalQuery(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function intQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = optionalQuery(req, name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new HttpError(400, `"${name}" must be a number`);
  return Math.min(max, Math.max(min, n));
}

// Content types the /api/proxy will relay (transcripts, chapters, small metadata).
const PROXY_TYPES = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|srt|x-subrip|vtt|octet-stream))/i;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src * blob:',
  "font-src 'self' data:",
  // Relays (wss), LNURL/Lightning-address servers and price APIs are reached directly from the browser.
  "connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:*",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function createApp(config: AppConfig): express.Express {
  const app = express();
  const btc = config.btc ?? new BtcService();
  const transcription = config.transcription ?? new TranscriptionService(defaultDeps(config.dataDir));

  app.disable('x-powered-by');
  app.use(hostGuard(config.allowedHosts ?? []));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/capabilities', async (_req, res) => {
    res.json({ ...(await transcription.capabilities()), defaultModel: DEFAULT_MODEL });
  });

  app.get('/api/feed', async (req, res) => {
    const result = await fetchFeed(query(req, 'url'), {
      etag: optionalQuery(req, 'etag'),
      lastModified: optionalQuery(req, 'lastModified'),
      limit: intQuery(req, 'limit', 300, 1, 1000),
    });
    res.json(result);
  });

  app.get('/api/article', async (req, res) => {
    res.json(await extractArticle(query(req, 'url')));
  });

  // Relays small text resources (transcripts, chapters) that publishers often serve without CORS headers.
  app.get('/api/proxy', async (req, res) => {
    const r = await safeFetch(query(req, 'url'), { maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, headers: { accept: 'text/*, application/json;q=0.9, */*;q=0.5' } });
    if (r.status >= 400) throw new HttpError(502, `The server answered HTTP ${r.status}`);
    const type = r.headers.get('content-type') ?? 'text/plain';
    if (!PROXY_TYPES.test(type)) throw new HttpError(415, `Refusing to relay ${type.split(';')[0]}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Upstream-Content-Type', type);
    res.setHeader('X-Final-Url', r.url);
    res.send(decodeBody(r.body, type));
  });

  app.get('/api/btc', async (req, res) => {
    res.json(await btc.get(optionalQuery(req, 'currency') ?? 'usd'));
  });

  app.post('/api/transcribe', (req, res) => {
    if (!req.is('application/json')) throw new HttpError(415, 'Send JSON');
    const { url, model, language, durationSec } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof url !== 'string') throw new HttpError(400, 'Missing "url"');
    const state = transcription.start({
      url,
      model: typeof model === 'string' ? model : DEFAULT_MODEL,
      language: typeof language === 'string' ? language : undefined,
      durationSec: typeof durationSec === 'number' ? durationSec : undefined,
    });
    res.status(202).json(state);
  });

  app.get('/api/transcribe/:id', (req, res) => {
    const state = transcription.get(String(req.params['id']), intQuery(req, 'since', 0, 0, 1_000_000));
    if (!state) throw new HttpError(404, 'Unknown transcription job');
    res.json(state);
  });

  app.delete('/api/transcribe/:id', (req, res) => {
    if (!transcription.cancel(String(req.params['id']))) throw new HttpError(404, 'Unknown transcription job');
    res.status(204).end();
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  if (config.staticDir && fs.existsSync(path.join(config.staticDir, 'index.html'))) {
    const dir = config.staticDir;
    app.use(
      express.static(dir, {
        index: false,
        setHeaders(res, file) {
          // Hashed assets never change; everything else must be revalidated.
          res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if ((err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' });
    } else if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON' });
    } else {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}
