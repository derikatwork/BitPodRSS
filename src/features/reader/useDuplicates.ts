import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { findDuplicates, pairKey, type DedupeItem, type DuplicateInfo } from '../../../shared/dedupe';
import { db } from '../../db';

const WINDOW_DAYS = 21;
const MAX_ARTICLES = 4000;

export interface DuplicateIndex {
  /** Article id -> info, for articles that have at least one suspected duplicate in another feed. */
  info: Map<number, DuplicateInfo>;
  /** Articles in the comparison window, by id (used to name the matches). */
  articles: Map<number, DedupeItem>;
  /** True while the first query is still loading. */
  loading: boolean;
}

/**
 * Suspected duplicates across feeds, recomputed whenever articles or "not a duplicate" decisions change.
 * Only recent articles are compared: duplicates appear within days of each other and it keeps this fast.
 */
export function useDuplicates(): DuplicateIndex {
  const items = useLiveQuery(async () => {
    const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
    const rows = await db.articles.where('publishedAt').above(cutoff).reverse().limit(MAX_ARTICLES).toArray();
    return rows.map((a): DedupeItem => ({ id: a.id, feedId: a.feedId, title: a.title, summary: a.summary, url: a.link, publishedAt: a.publishedAt }));
  }, []);
  const ignores = useLiveQuery(() => db.dupIgnores.toArray(), []);

  return useMemo(() => {
    const list = items ?? [];
    const ignored = new Set((ignores ?? []).map((i) => i.key));
    return {
      info: findDuplicates(list, { ignoredPairs: ignored }),
      articles: new Map(list.map((i) => [i.id, i])),
      loading: items === undefined,
    };
  }, [items, ignores]);
}

/** Record that two articles are not duplicates so they are not flagged again. */
export async function markNotDuplicate(a: number, b: number): Promise<void> {
  await db.dupIgnores.put({ key: pairKey(a, b) });
}
