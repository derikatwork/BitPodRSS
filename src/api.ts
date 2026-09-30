import type {
  BtcHistory,
  Capabilities,
  ExtractedArticle,
  FeedNotModified,
  ParsedFeed,
  TranscribeJobState,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Could not reach the BitPodRSS server. Is it running?');
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export const api = {
  feed: (url: string, validators: { etag?: string; lastModified?: string; limit?: number } = {}) =>
    request<ParsedFeed | FeedNotModified>(`/api/feed?${qs({ url, ...validators })}`),

  article: (url: string) => request<ExtractedArticle>(`/api/article?${qs({ url })}`),

  /** Fetch a small text resource (transcript, chapters) through the server to sidestep CORS. */
  async text(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`/api/proxy?${qs({ url })}`);
    } catch {
      throw new ApiError(0, 'Could not reach the BitPodRSS server. Is it running?');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
    }
    return res.text();
  },

  btc: (currency: string) => request<BtcHistory & { stale?: boolean }>(`/api/btc?${qs({ currency })}`),

  capabilities: () => request<Capabilities & { defaultModel: string }>('/api/capabilities'),

  transcribe: {
    start: (body: { url: string; model: string; language?: string; durationSec?: number }) =>
      request<TranscribeJobState>('/api/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    poll: (id: string, since: number) => request<TranscribeJobState>(`/api/transcribe/${encodeURIComponent(id)}?since=${since}`),
    cancel: (id: string) => request<void>(`/api/transcribe/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
};

export function isNotModified(r: ParsedFeed | FeedNotModified): r is FeedNotModified {
  return 'notModified' in r;
}
