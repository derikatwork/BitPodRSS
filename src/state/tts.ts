import { create } from 'zustand';
import { buildSpokenArticle, chunkForSpeech, rankVoices, type SpeechChunk } from '../../shared/speech';
import { api } from '../api';
import { db, type Article } from '../db';
import { summarize } from '../../shared/summarize';
import { Speaker, htmlToPlainText, loadVoices, speechSupported } from '../lib/tts';
import { errorMessage, toast } from './toasts';
import { useSettings } from './settings';

type Status = 'idle' | 'loading' | 'speaking' | 'paused';

interface TtsState {
  status: Status;
  articleId?: number;
  title?: string;
  chunks: SpeechChunk[];
  index: number;
  voices: SpeechSynthesisVoice[];
  supported: boolean;
  init: () => Promise<void>;
  listen: (article: Article) => Promise<void>;
  toggle: () => void;
  stop: () => void;
  skip: (delta: number) => void;
}

let speaker: Speaker | undefined;

function currentVoice(voices: SpeechSynthesisVoice[], lang: string | undefined): SpeechSynthesisVoice | undefined {
  const { ttsVoiceURI, ttsPreferLocal } = useSettings.getState();
  const chosen = ttsVoiceURI && voices.find((v) => v.voiceURI === ttsVoiceURI);
  if (chosen) return chosen;
  return rankVoices(voices, { lang, preferLocal: ttsPreferLocal })[0];
}

export const useTts = create<TtsState>((set, get) => {
  const speakOpts = (lang?: string) => ({ voice: currentVoice(get().voices, lang), rate: useSettings.getState().ttsRate, lang });

  const ensureSpeaker = (): Speaker =>
    (speaker ??= new Speaker({
      onChunk: (index) => set({ index }),
      onEnd: () => set({ status: 'idle', chunks: [], index: 0, articleId: undefined, title: undefined }),
      onError: (message) => {
        toast.error(message);
        set({ status: 'paused' });
      },
    }));

  // Changing voice or speed in Settings applies immediately, even mid-article.
  useSettings.subscribe((s, prev) => {
    if (s.ttsRate !== prev.ttsRate || s.ttsVoiceURI !== prev.ttsVoiceURI || s.ttsPreferLocal !== prev.ttsPreferLocal) {
      if (get().status === 'speaking') speaker?.update(speakOpts());
    }
  });

  return {
    status: 'idle',
    chunks: [],
    index: 0,
    voices: [],
    supported: speechSupported(),

    async init() {
      if (get().voices.length) return;
      set({ voices: await loadVoices() });
    },

    async listen(article) {
      if (!speechSupported()) return void toast.error('This browser does not support speech synthesis.');
      get().stop();
      set({ status: 'loading', articleId: article.id, title: article.title });
      try {
        await get().init();
        let { extracted } = article;
        if (!extracted && article.link) {
          try {
            const r = await api.article(article.link);
            extracted = { text: r.text, contentHtml: r.contentHtml, byline: r.byline, siteName: r.siteName };
            await db.articles.update(article.id, { extracted, autoSummary: summarize(r.text) });
          } catch {
            // Fall back to what the feed gave us below.
          }
        }
        const body = extracted?.text ?? (article.contentHtml ? htmlToPlainText(article.contentHtml) : article.summary);
        const text = buildSpokenArticle({ title: article.title, byline: extracted?.byline ?? article.author, siteName: extracted?.siteName, body });
        const chunks = chunkForSpeech(text);
        if (!chunks.length) throw new Error('There is no text to read for this article.');
        // A newer request (or Stop) may have arrived while we were fetching.
        if (get().articleId !== article.id || get().status !== 'loading') return;
        set({ chunks, index: 0, status: 'speaking' });
        ensureSpeaker().start(chunks, speakOpts(), 0);
      } catch (err) {
        toast.error(errorMessage(err));
        set({ status: 'idle', articleId: undefined, title: undefined, chunks: [], index: 0 });
      }
    },

    toggle() {
      const { status } = get();
      if (status === 'speaking') {
        speaker?.pause();
        set({ status: 'paused' });
      } else if (status === 'paused') {
        speaker?.update(speakOpts());
        speaker?.resume();
        set({ status: 'speaking' });
      }
    },

    stop() {
      speaker?.stop();
      set({ status: 'idle', chunks: [], index: 0, articleId: undefined, title: undefined });
    },

    skip(delta) {
      speaker?.skip(delta);
    },
  };
});
