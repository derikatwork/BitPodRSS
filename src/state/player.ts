import { create } from 'zustand';
import { db } from '../db';
import { useSettings } from './settings';
import { claimAudio, registerAudio } from './audioFocus';
import { errorMessage, toast } from './toasts';

interface PlayerState {
  episodeId?: number;
  podcastId?: number;
  title?: string;
  podcastTitle?: string;
  imageUrl?: string;
  /** Queue the current episode came from; when it ends, the next item of this queue plays. */
  queueId?: number;
  playing: boolean;
  buffering: boolean;
  /** Seconds. */
  position: number;
  duration: number;
  error?: string;
  play: (episodeId: number, opts?: { queueId?: number; startAt?: number }) => Promise<void>;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (delta: number) => void;
  setRate: (rate: number) => void;
  stop: () => void;
}

const SAVE_EVERY_SECONDS = 5;
const BACK_SECONDS = 15;
const FORWARD_SECONDS = 30;

let audio: HTMLAudioElement | undefined;
let pendingSeek = 0;
let lastSaved = 0;

export const usePlayer = create<PlayerState>((set, get) => {
  const a = (): HTMLAudioElement => {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    wire(audio);
    return audio;
  };

  const savePosition = async (): Promise<void> => {
    const { episodeId } = get();
    if (!episodeId || !audio) return;
    const position = audio.currentTime;
    lastSaved = position;
    await db.episodes.update(episodeId, { position: Math.floor(position) });
  };

  const advance = async (finishedId: number, queueId: number | undefined): Promise<void> => {
    if (!queueId) return;
    const q = await db.queues.get(queueId);
    if (!q) return;
    const idx = q.episodeIds.indexOf(finishedId);
    const next = idx >= 0 ? q.episodeIds[idx + 1] : undefined;
    // Finished episodes leave the queue, so a queue always reads as "what is still to come".
    await db.queues.update(queueId, { episodeIds: q.episodeIds.filter((id) => id !== finishedId) });
    if (next !== undefined) await get().play(next, { queueId });
  };

  function wire(el: HTMLAudioElement): void {
    el.addEventListener('timeupdate', () => {
      set({ position: el.currentTime });
      if (Math.abs(el.currentTime - lastSaved) >= SAVE_EVERY_SECONDS) void savePosition();
    });
    el.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(el.duration)) set({ duration: el.duration });
      if (pendingSeek > 0) {
        el.currentTime = Math.min(pendingSeek, Math.max(0, el.duration - 1));
        pendingSeek = 0;
      }
      const { episodeId } = get();
      if (episodeId && Number.isFinite(el.duration)) void db.episodes.update(episodeId, { duration: Math.round(el.duration) });
    });
    el.addEventListener('durationchange', () => Number.isFinite(el.duration) && set({ duration: el.duration }));
    el.addEventListener('play', () => set({ playing: true, error: undefined }));
    el.addEventListener('pause', () => {
      set({ playing: false });
      void savePosition();
    });
    el.addEventListener('waiting', () => set({ buffering: true }));
    el.addEventListener('playing', () => set({ buffering: false, playing: true }));
    el.addEventListener('canplay', () => set({ buffering: false }));
    el.addEventListener('error', () => {
      const message = el.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'This episode could not be played (unsupported or unavailable audio file).' : 'Playback failed. Check your connection and try again.';
      set({ playing: false, buffering: false, error: message });
      toast.error(message);
    });
    el.addEventListener('ended', () => {
      const { episodeId, queueId } = get();
      set({ playing: false });
      if (!episodeId) return;
      void (async () => {
        await db.episodes.update(episodeId, { played: 1, position: 0 });
        lastSaved = 0;
        await advance(episodeId, queueId);
      })();
    });
  }

  registerAudio('podcast', () => {
    if (audio && !audio.paused) audio.pause();
  });

  const updateMediaSession = (): void => {
    if (!('mediaSession' in navigator)) return;
    const { title, podcastTitle, imageUrl } = get();
    navigator.mediaSession.metadata = new MediaMetadata({ title: title ?? '', artist: podcastTitle ?? '', artwork: imageUrl ? [{ src: imageUrl }] : [] });
    navigator.mediaSession.setActionHandler('play', () => get().toggle());
    navigator.mediaSession.setActionHandler('pause', () => get().toggle());
    navigator.mediaSession.setActionHandler('seekbackward', () => get().skip(-BACK_SECONDS));
    navigator.mediaSession.setActionHandler('seekforward', () => get().skip(FORWARD_SECONDS));
    navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime !== undefined && get().seek(d.seekTime));
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      const { episodeId, queueId } = get();
      if (episodeId) void advance(episodeId, queueId);
    });
  };

  return {
    playing: false,
    buffering: false,
    position: 0,
    duration: 0,

    async play(episodeId, opts = {}) {
      const el = a();
      // Already loaded: just resume.
      if (get().episodeId === episodeId && el.src) {
        if (opts.startAt !== undefined) el.currentTime = opts.startAt;
        await el.play().catch(() => undefined);
        return;
      }
      try {
        const episode = await db.episodes.get(episodeId);
        if (!episode) throw new Error('That episode no longer exists.');
        const podcast = await db.podcasts.get(episode.podcastId);

        claimAudio('podcast'); // never talk over a podcast
        await savePosition();

        const resume = opts.startAt ?? (episode.position > 5 && (!episode.duration || episode.position < episode.duration - 10) ? episode.position : 0);
        pendingSeek = resume;
        lastSaved = resume;
        el.src = episode.enclosureUrl;
        el.playbackRate = useSettings.getState().playbackRate;
        set({
          episodeId,
          podcastId: episode.podcastId,
          title: episode.title,
          podcastTitle: podcast?.title,
          imageUrl: episode.imageUrl ?? podcast?.imageUrl,
          queueId: opts.queueId,
          position: resume,
          duration: episode.duration ?? 0,
          playing: false,
          buffering: true,
          error: undefined,
        });
        updateMediaSession();
        await el.play();
      } catch (err) {
        // AbortError happens when the user switches episodes quickly; it is not a failure.
        if ((err as DOMException)?.name === 'AbortError') return;
        const message = (err as DOMException)?.name === 'NotAllowedError' ? 'Your browser blocked autoplay. Press play to start.' : errorMessage(err);
        set({ buffering: false, error: message });
        toast.error(message);
      }
    },

    toggle() {
      if (!get().episodeId) return;
      const el = a();
      if (el.paused) {
        claimAudio('podcast');
        void el.play().catch((e: unknown) => toast.error(errorMessage(e)));
      } else el.pause();
    },

    seek(seconds) {
      if (!get().episodeId) return;
      const el = a();
      const max = Number.isFinite(el.duration) ? el.duration : Infinity;
      el.currentTime = Math.min(Math.max(0, seconds), max);
      set({ position: el.currentTime });
    },

    skip(delta) {
      get().seek(a().currentTime + delta);
    },

    setRate(rate) {
      useSettings.getState().set({ playbackRate: rate });
      if (audio) audio.playbackRate = rate;
    },

    stop() {
      if (!audio) return;
      void savePosition();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      set({ episodeId: undefined, podcastId: undefined, title: undefined, podcastTitle: undefined, imageUrl: undefined, queueId: undefined, playing: false, position: 0, duration: 0, error: undefined });
    },
  };
});

export { BACK_SECONDS, FORWARD_SECONDS };
