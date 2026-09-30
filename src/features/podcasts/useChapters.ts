import { useEffect, useState } from 'react';
import type { Chapter } from '../../../shared/types';
import { parseChapters } from '../../../shared/transcript';
import { api } from '../../api';
import { db } from '../../db';

const cache = new Map<number, Chapter[]>();

/** Chapters for an episode (Podcasting 2.0 `podcast:chapters`), fetched once through the server to avoid CORS. */
export function useChapters(episodeId: number | undefined): { chapters: Chapter[]; loading: boolean } {
  const [state, setState] = useState<{ id?: number; chapters: Chapter[]; loading: boolean }>({ chapters: [], loading: false });

  useEffect(() => {
    let cancelled = false;
    if (!episodeId) {
      setState({ chapters: [], loading: false });
      return;
    }
    const cached = cache.get(episodeId);
    if (cached) {
      setState({ id: episodeId, chapters: cached, loading: false });
      return;
    }
    setState({ id: episodeId, chapters: [], loading: true });
    void (async () => {
      let chapters: Chapter[] = [];
      try {
        const ref = (await db.episodes.get(episodeId))?.meta?.chapters;
        if (ref) chapters = parseChapters(await api.text(ref.url));
      } catch {
        // Missing or malformed chapters are not an error worth surfacing; the episode still plays.
      }
      cache.set(episodeId, chapters);
      if (!cancelled) setState({ id: episodeId, chapters, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [episodeId]);

  return { chapters: state.id === episodeId ? state.chapters : [], loading: state.loading };
}
