import type { SpeechChunk } from '../../shared/speech';

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

/** `getVoices()` is empty until the browser has loaded them; wait for `voiceschanged` (with a timeout). */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener('voiceschanged', done);
  });
}

export interface SpeakerCallbacks {
  onChunk: (index: number) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface SpeakOptions {
  voice?: SpeechSynthesisVoice;
  rate: number;
  lang?: string;
}

const PARAGRAPH_PAUSE_MS = 350;

// Utterances are referenced here while speaking: if one is garbage-collected mid-speech, Chrome silently
// drops its `end` event and the queue would stall.
const live = new Set<SpeechSynthesisUtterance>();

/**
 * Reads a list of chunks aloud, one utterance at a time.
 *
 * Pausing cancels the current utterance and remembers its index (resuming re-reads that chunk), because
 * native pause/resume is unreliable across browsers and unsupported on some platforms.
 */
export class Speaker {
  private chunks: SpeechChunk[] = [];
  private index = 0;
  private opts: SpeakOptions = { rate: 1 };
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private cb: SpeakerCallbacks) {}

  get position(): number {
    return this.index;
  }

  get speaking(): boolean {
    return this.active;
  }

  start(chunks: SpeechChunk[], opts: SpeakOptions, from = 0): void {
    this.cancel();
    this.chunks = chunks;
    this.opts = opts;
    this.index = Math.min(Math.max(0, from), Math.max(0, chunks.length - 1));
    if (!chunks.length) return this.cb.onEnd();
    this.active = true;
    this.speakCurrent();
  }

  /** Stop speaking but keep the position so {@link resume} continues from the current chunk. */
  pause(): void {
    this.cancel();
  }

  resume(): void {
    if (!this.chunks.length || this.active) return;
    this.active = true;
    this.speakCurrent();
  }

  stop(): void {
    this.cancel();
    this.chunks = [];
    this.index = 0;
  }

  /** Move by `delta` chunks and continue speaking if we were. */
  skip(delta: number): void {
    if (!this.chunks.length) return;
    const wasActive = this.active;
    this.cancel();
    this.index = Math.min(this.chunks.length - 1, Math.max(0, this.index + delta));
    this.cb.onChunk(this.index);
    if (wasActive) {
      this.active = true;
      this.speakCurrent();
    }
  }

  /** Apply new voice/rate settings; takes effect on the current chunk. */
  update(opts: SpeakOptions): void {
    this.opts = opts;
    if (this.active) {
      this.cancel();
      this.active = true;
      this.speakCurrent();
    }
  }

  private cancel(): void {
    this.generation++;
    this.active = false;
    live.clear();
    clearTimeout(this.timer);
    if (speechSupported()) window.speechSynthesis.cancel();
  }

  private speakCurrent(): void {
    const chunk = this.chunks[this.index];
    if (!chunk) {
      this.active = false;
      return this.cb.onEnd();
    }
    const gen = this.generation;
    const u = new SpeechSynthesisUtterance(chunk.text);
    if (this.opts.voice) {
      u.voice = this.opts.voice;
      u.lang = this.opts.voice.lang;
    } else if (this.opts.lang) u.lang = this.opts.lang;
    u.rate = this.opts.rate;
    u.onend = () => {
      live.delete(u);
      if (gen !== this.generation) return;
      this.index++;
      if (this.index >= this.chunks.length) {
        this.active = false;
        this.index = this.chunks.length - 1;
        return this.cb.onEnd();
      }
      this.cb.onChunk(this.index);
      if (chunk.paragraphEnd) this.timer = setTimeout(() => gen === this.generation && this.speakCurrent(), PARAGRAPH_PAUSE_MS);
      else this.speakCurrent();
    };
    u.onerror = (e) => {
      live.delete(u);
      if (gen !== this.generation) return;
      // "canceled"/"interrupted" are what we cause ourselves; anything else is a real failure.
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      this.active = false;
      this.cb.onError(`Speech failed (${e.error}). Try another voice in Settings.`);
    };
    live.add(u);
    this.cb.onChunk(this.index);
    window.speechSynthesis.speak(u);
  }
}

/** Plain text of an HTML fragment, with paragraph breaks kept (for read-aloud of feed-supplied content). */
export function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi, '\n\n').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Speak a short sample so the user can judge a voice before choosing it. */
export function previewVoice(voice: SpeechSynthesisVoice | undefined, rate: number): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance('This is how your articles will sound when read aloud.');
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = rate;
  window.speechSynthesis.speak(u);
}
