import { useLiveQuery } from 'dexie-react-hooks';
import type { ValueBlock } from '../../../shared/types';
import { isPayableValue } from '../../../shared/value';
import { db, type Episode, type Podcast } from '../../db';

export interface EpisodeValue {
  episode?: Episode;
  podcast?: Podcast;
  /** The value block that applies to this episode (episode-level overrides the show's), if we can pay it. */
  value?: ValueBlock;
}

export function useEpisodeValue(episodeId: number | undefined): EpisodeValue {
  return (
    useLiveQuery(async (): Promise<EpisodeValue> => {
      if (!episodeId) return {};
      const episode = await db.episodes.get(episodeId);
      const podcast = episode && (await db.podcasts.get(episode.podcastId));
      const v = episode?.meta?.value ?? podcast?.meta?.value;
      return { episode, podcast, value: isPayableValue(v) ? v : undefined };
    }, [episodeId]) ?? {}
  );
}
