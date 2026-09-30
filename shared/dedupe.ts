import { normalizeUrl } from './url';
import { tokenize } from './text';

export interface DedupeItem {
  id: number;
  feedId: number;
  title: string;
  summary?: string;
  url?: string;
  /** Milliseconds since epoch. */
  publishedAt?: number;
}

export type MatchKind = 'exact' | 'likely' | 'possible';

export interface DuplicateMatch {
  id: number;
  /** 0..1 */
  score: number;
  kind: MatchKind;
}

export interface DuplicateInfo {
  /** Identifies the group of mutually-related articles. */
  clusterId: number;
  /** The article the others are considered copies of (earliest published). */
  primaryId: number;
  /** Number of articles in the cluster, including this one. */
  size: number;
  /** Direct matches for this article, best first. */
  matches: DuplicateMatch[];
}

export interface DedupeOptions {
  /** Below this score a pair is not reported. Default 0.6. */
  minScore?: number;
  /** At or above this score a pair is reported as "likely". Default 0.8. */
  likelyScore?: number;
  /** Articles published further apart than this are never compared. Default 72 hours. */
  windowMs?: number;
  /** Only compare articles from different feeds. Default true. */
  crossFeedOnly?: boolean;
  /** Pairs the user has marked "not a duplicate" (see {@link pairKey}). */
  ignoredPairs?: ReadonlySet<string>;
}

const DEFAULTS = { minScore: 0.6, likelyScore: 0.8, windowMs: 72 * 3600_000, crossFeedOnly: true };

/** Order-independent key for a pair of article ids. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Remove a trailing "- Site Name" / "| Site Name" from a headline, which differs between outlets that
 * carry the same story. Only strips when what remains is still a real headline (3+ words).
 */
export function stripSiteSuffix(title: string): string {
  const m = /^(.*\S)\s+[|\-–—:]\s+([^|\-–—:]{2,40})$/.exec(title.trim());
  if (!m) return title;
  const head = m[1]!;
  const tail = m[2]!;
  return head.split(/\s+/).length >= 3 && tail.split(/\s+/).length <= 4 ? head : title;
}

interface Prepared {
  item: DedupeItem;
  urlKey?: string;
  titleTokens: string[];
  titleSet: Set<string>;
  summarySet: Set<string>;
  summaryPrefix?: string;
}

function prepare(item: DedupeItem): Prepared {
  const titleTokens = tokenize(stripSiteSuffix(item.title), { stopwords: true });
  const summaryTokens = tokenize(item.summary ?? '', { stopwords: true }).slice(0, 80);
  return {
    item,
    urlKey: normalizeUrl(item.url),
    titleTokens,
    titleSet: new Set(titleTokens),
    summarySet: new Set(summaryTokens),
    summaryPrefix: summaryTokens.length >= 10 ? summaryTokens.slice(0, 10).join(' ') : undefined,
  };
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

/** Similarity of two prepared articles in 0..1 (URL equality is handled separately). */
function similarity(a: Prepared, b: Prepared): number {
  const minTitle = Math.min(a.titleSet.size, b.titleSet.size);
  const titleSim = Math.max(jaccard(a.titleSet, b.titleSet), minTitle >= 4 ? 0.9 * overlap(a.titleSet, b.titleSet) : 0);
  const haveSummary = a.summarySet.size >= 10 && b.summarySet.size >= 10;
  const summarySim = haveSummary ? Math.max(jaccard(a.summarySet, b.summarySet), 0.9 * overlap(a.summarySet, b.summarySet)) : 0;

  let score = 0;
  // Headlines of four or more meaningful words are strong evidence on their own; shorter ones ("Daily update") are not.
  if (minTitle >= 4) score = titleSim * 0.92;
  if (haveSummary) {
    score = Math.max(score, 0.55 * titleSim + 0.45 * summarySim);
    // Rewritten headline over the same wire copy.
    if (summarySim >= 0.85) score = Math.max(score, summarySim * 0.95);
  }
  return Math.min(score, 0.99);
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

interface Edge {
  a: number;
  b: number;
  score: number;
  kind: MatchKind;
}

/**
 * Find articles that are probably the same story. Returns a map from article id to its
 * {@link DuplicateInfo}; articles with no duplicates are absent.
 *
 * Candidate pairs come from an inverted index over headline words (and a hash of the opening of the
 * summary), so this stays near-linear for thousands of articles instead of comparing every pair.
 */
export function findDuplicates(items: readonly DedupeItem[], options: DedupeOptions = {}): Map<number, DuplicateInfo> {
  const opts = { ...DEFAULTS, ...options };
  const prepared = items.map(prepare);
  const edges = new Map<string, Edge>();

  const consider = (i: number, j: number, exactUrl: boolean): void => {
    if (i === j) return;
    const a = prepared[i]!;
    const b = prepared[j]!;
    if (opts.crossFeedOnly && a.item.feedId === b.item.feedId) return;
    if (a.item.id === b.item.id) return;
    const key = pairKey(a.item.id, b.item.id);
    if (edges.has(key) || opts.ignoredPairs?.has(key)) return;
    const pa = a.item.publishedAt;
    const pb = b.item.publishedAt;
    if (!exactUrl && pa != null && pb != null && Math.abs(pa - pb) > opts.windowMs) return;

    const score = exactUrl ? 1 : similarity(a, b);
    if (score < opts.minScore) return;
    const kind: MatchKind = exactUrl ? 'exact' : score >= opts.likelyScore ? 'likely' : 'possible';
    edges.set(key, { a: i, b: j, score, kind });
  };

  // 1. Same canonical URL.
  const byUrl = new Map<string, number[]>();
  prepared.forEach((p, i) => {
    if (!p.urlKey) return;
    const list = byUrl.get(p.urlKey);
    if (list) list.push(i);
    else byUrl.set(p.urlKey, [i]);
  });
  for (const group of byUrl.values()) {
    const capped = group.slice(0, 50);
    for (let x = 0; x < capped.length; x++) for (let y = x + 1; y < capped.length; y++) consider(capped[x]!, capped[y]!, true);
  }

  // 2. Same opening summary text (syndicated copy under a different headline).
  const byPrefix = new Map<string, number[]>();
  prepared.forEach((p, i) => {
    if (!p.summaryPrefix) return;
    const list = byPrefix.get(p.summaryPrefix);
    if (list) list.push(i);
    else byPrefix.set(p.summaryPrefix, [i]);
  });
  for (const group of byPrefix.values()) {
    const capped = group.slice(0, 50);
    for (let x = 0; x < capped.length; x++) for (let y = x + 1; y < capped.length; y++) consider(capped[x]!, capped[y]!, false);
  }

  // 3. Shared headline vocabulary, via an inverted index that ignores words appearing in too many headlines.
  const postings = new Map<string, number[]>();
  prepared.forEach((p, i) => {
    for (const t of p.titleSet) {
      if (t.length < 3) continue;
      const list = postings.get(t);
      if (list) list.push(i);
      else postings.set(t, [i]);
    }
  });
  const maxPosting = Math.max(60, Math.floor(prepared.length * 0.05));
  prepared.forEach((p, i) => {
    const shared = new Map<number, number>();
    for (const t of p.titleSet) {
      const list = postings.get(t);
      if (!list || list.length > maxPosting) continue;
      for (const j of list) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
    }
    for (const [j, count] of shared) {
      const need = Math.min(2, p.titleSet.size, prepared[j]!.titleSet.size);
      if (count >= need) consider(i, j, false);
    }
  });

  if (!edges.size) return new Map();

  // Cluster and describe.
  const uf = new UnionFind(prepared.length);
  const adjacency = new Map<number, DuplicateMatch[]>();
  const push = (from: number, to: number, e: Edge): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ id: prepared[to]!.item.id, score: round(e.score), kind: e.kind });
    adjacency.set(from, list);
  };
  for (const e of edges.values()) {
    uf.union(e.a, e.b);
    push(e.a, e.b, e);
    push(e.b, e.a, e);
  }

  const clusters = new Map<number, number[]>();
  for (const idx of adjacency.keys()) {
    const root = uf.find(idx);
    const list = clusters.get(root) ?? [];
    list.push(idx);
    clusters.set(root, list);
  }

  const result = new Map<number, DuplicateInfo>();
  for (const members of clusters.values()) {
    const earliest = [...members].sort((x, y) => {
      const px = prepared[x]!.item.publishedAt ?? Number.POSITIVE_INFINITY;
      const py = prepared[y]!.item.publishedAt ?? Number.POSITIVE_INFINITY;
      return px - py || prepared[x]!.item.id - prepared[y]!.item.id;
    })[0]!;
    const clusterId = Math.min(...members.map((m) => prepared[m]!.item.id));
    const primaryId = prepared[earliest]!.item.id;
    for (const m of members) {
      const matches = (adjacency.get(m) ?? []).sort((x, y) => y.score - x.score);
      result.set(prepared[m]!.item.id, { clusterId, primaryId, size: members.length, matches });
    }
  }
  return result;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
