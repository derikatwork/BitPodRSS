import { create } from 'zustand';

export type Page = 'reader' | 'podcasts' | 'wallet' | 'settings';

interface NavState {
  page: Page;
  /** Podcast to show on the Podcasts page, when navigating from elsewhere (e.g. the player). */
  podcastId?: number;
  episodeId?: number;
  go: (page: Page, target?: { podcastId?: number; episodeId?: number }) => void;
}

export const useNav = create<NavState>((set) => ({
  page: 'reader',
  go: (page, target) => set({ page, podcastId: target?.podcastId, episodeId: target?.episodeId }),
}));
