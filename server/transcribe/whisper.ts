import { HttpError } from '../security';
import { findModel } from './models';
import type { AsrChunk, AsrFn } from './pipeline';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The small slice of transformers.js we use. Declared here rather than taken from the package's own types so
 * that this project type-checks and builds even when the optional package is not installed.
 */
interface Transformers {
  env: { cacheDir: string };
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<any>;
}

let transformers: Promise<Transformers> | undefined;

/**
 * Load transformers.js on first use. It is an optional dependency (it pulls in native ONNX runtime
 * binaries), so the rest of the app must keep working when it is missing or fails to load.
 */
export function loadTransformers(): Promise<Transformers> {
  // A variable specifier keeps the compiler and bundlers from requiring the package to be present.
  const specifier = '@huggingface/transformers';
  transformers ??= import(specifier) as Promise<Transformers>;
  return transformers;
}

export async function whisperStatus(): Promise<{ available: boolean; reason?: string }> {
  try {
    await loadTransformers();
    return { available: true };
  } catch (err) {
    const message = (err as Error).message || String(err);
    return {
      available: false,
      reason: /Cannot find (package|module)/i.test(message)
        ? 'The optional package @huggingface/transformers is not installed. Run "npm install @huggingface/transformers".'
        : `The speech engine could not be loaded: ${message.split('\n')[0]}`,
    };
  }
}

export interface LoadOptions {
  cacheDir: string;
  language?: string;
  onMessage?: (message: string) => void;
}

interface Loaded {
  model: string;
  run: (audio: Float32Array, language?: string) => Promise<AsrChunk[]>;
  dispose: () => Promise<void>;
}

let current: Promise<Loaded> | undefined;
let currentModel: string | undefined;

async function create(modelId: string, opts: LoadOptions): Promise<Loaded> {
  const info = findModel(modelId);
  if (!info) throw new HttpError(400, 'Unknown transcription model');
  const tf = await loadTransformers().catch((err: Error) => {
    throw new HttpError(501, `Local transcription is unavailable: ${err.message.split('\n')[0]}`);
  });
  tf.env.cacheDir = opts.cacheDir;

  const progress_callback = (p: any): void => {
    if (p?.status === 'progress_total' && typeof p.progress === 'number') opts.onMessage?.(`Downloading speech model… ${Math.round(p.progress)}%`);
  };
  opts.onMessage?.('Loading speech model…');
  let asr: any;
  try {
    // 8-bit quantised weights: a fraction of the download and noticeably faster on CPU.
    asr = await tf.pipeline('automatic-speech-recognition', modelId, { dtype: 'q8', progress_callback });
  } catch {
    asr = await tf.pipeline('automatic-speech-recognition', modelId, { progress_callback });
  }

  return {
    model: modelId,
    async run(audio, language) {
      // English-only checkpoints reject `language`/`task`.
      const options: Record<string, unknown> = { return_timestamps: true };
      if (info.multilingual) {
        options['task'] = 'transcribe';
        if (language) options['language'] = language;
      }
      const out = await asr(audio, options);
      const chunks: { timestamp: [number, number | null]; text: string }[] = out?.chunks ?? [];
      if (!chunks.length && out?.text?.trim()) return [{ start: 0, end: null, text: out.text }];
      return chunks.map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? null, text: c.text }));
    },
    dispose: async () => {
      await asr?.dispose?.();
    },
  };
}

/** Load (and keep) one model at a time; asking for a different model frees the previous one. */
export async function loadWhisper(modelId: string, opts: LoadOptions): Promise<AsrFn> {
  if (currentModel !== modelId || !current) {
    const previous = current;
    currentModel = modelId;
    current = create(modelId, opts);
    current.catch(() => {
      if (currentModel === modelId) {
        current = undefined;
        currentModel = undefined;
      }
    });
    previous?.then((p) => p.dispose()).catch(() => undefined);
  }
  const loaded = await current;
  return (audio) => loaded.run(audio, opts.language);
}
