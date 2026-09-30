import { create } from 'zustand';
import type { TranscribeStatus, Transcript, TranscriptSegment } from '../../shared/types';
import { api } from '../api';
import { db } from '../db';
import { errorMessage, toast } from './toasts';

export interface JobView {
  episodeId: number;
  jobId?: string;
  status: TranscribeStatus | 'starting';
  message?: string;
  /** 0..1 when the episode length is known. */
  progress?: number;
  segments: TranscriptSegment[];
  error?: string;
  model: string;
}

interface TranscribeStore {
  jobs: Record<number, JobView>;
  start: (episodeId: number, opts: { model: string; language?: string }) => Promise<void>;
  cancel: (episodeId: number) => Promise<void>;
  dismiss: (episodeId: number) => void;
}

/** A copy of `jobs` without the given episode's job. */
function without(jobs: Record<number, JobView>, episodeId: number): Record<number, JobView> {
  const copy = { ...jobs };
  delete copy[episodeId];
  return copy;
}

const POLL_MS = 1500;
const MAX_POLL_FAILURES = 5;

/** Store or replace the transcript for an episode. */
export async function saveTranscript(episodeId: number, t: Transcript, meta: { source: 'publisher' | 'local'; model?: string; language?: string }): Promise<void> {
  const existing = await db.transcripts.where('episodeId').equals(episodeId).first();
  const row = { episodeId, source: meta.source, model: meta.model, language: meta.language, timed: t.timed, segments: t.segments, createdAt: Date.now() };
  if (existing) await db.transcripts.update(existing.id, row);
  else await db.transcripts.add(row);
}

/**
 * Drives server-side transcription jobs. The polling loop lives here rather than in a component so a job
 * keeps running, and its result is saved, even if the user navigates away while it works.
 */
export const useTranscribe = create<TranscribeStore>((set, get) => {
  const update = (episodeId: number, patch: Partial<JobView>): void => set((s) => (s.jobs[episodeId] ? { jobs: { ...s.jobs, [episodeId]: { ...s.jobs[episodeId]!, ...patch } } } : s));

  const poll = async (episodeId: number, language?: string): Promise<void> => {
    let failures = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const job = get().jobs[episodeId];
      if (!job?.jobId) return; // dismissed
      try {
        const state = await api.transcribe.poll(job.jobId, job.segments.length);
        failures = 0;
        update(episodeId, { status: state.status, message: state.message, progress: state.progress, segments: [...job.segments, ...state.segments], error: state.error });
        if (state.status === 'done') {
          const all = get().jobs[episodeId]!.segments;
          await saveTranscript(episodeId, { timed: true, segments: all }, { source: 'local', model: job.model, language });
          toast.ok('Transcription finished.');
          set((s) => ({ jobs: without(s.jobs, episodeId) }));
          return;
        }
        if (state.status === 'error' || state.status === 'cancelled') return;
      } catch (err) {
        if (++failures >= MAX_POLL_FAILURES) {
          update(episodeId, { status: 'error', error: `Lost contact with the server: ${errorMessage(err)}` });
          return;
        }
      }
    }
  };

  return {
    jobs: {},

    async start(episodeId, { model, language }) {
      const episode = await db.episodes.get(episodeId);
      if (!episode) return;
      set((s) => ({ jobs: { ...s.jobs, [episodeId]: { episodeId, status: 'starting', segments: [], model } } }));
      try {
        const state = await api.transcribe.start({ url: episode.enclosureUrl, model, language: language || undefined, durationSec: episode.duration });
        update(episodeId, { jobId: state.id, status: state.status, message: state.message, progress: state.progress, segments: state.segments });
        if (state.status === 'done') {
          await saveTranscript(episodeId, { timed: true, segments: state.segments }, { source: 'local', model, language });
          set((s) => ({ jobs: without(s.jobs, episodeId) }));
          return;
        }
        void poll(episodeId, language);
      } catch (err) {
        update(episodeId, { status: 'error', error: errorMessage(err) });
      }
    },

    async cancel(episodeId) {
      const job = get().jobs[episodeId];
      if (job?.jobId) await api.transcribe.cancel(job.jobId).catch(() => undefined);
      update(episodeId, { status: 'cancelled', message: undefined });
    },

    dismiss(episodeId) {
      set((s) => ({ jobs: without(s.jobs, episodeId) }));
    },
  };
});
