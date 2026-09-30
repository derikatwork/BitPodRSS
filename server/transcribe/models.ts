import type { WhisperModelInfo } from '../../shared/types';

/** Whisper checkpoints converted for transformers.js. English-only models are faster and more accurate for English. */
export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'Xenova/whisper-tiny.en', label: 'Tiny (English) – fastest', multilingual: false, approxMb: 40 },
  { id: 'Xenova/whisper-base.en', label: 'Base (English) – balanced', multilingual: false, approxMb: 75 },
  { id: 'Xenova/whisper-small.en', label: 'Small (English) – most accurate', multilingual: false, approxMb: 250 },
  { id: 'Xenova/whisper-tiny', label: 'Tiny (multilingual)', multilingual: true, approxMb: 40 },
  { id: 'Xenova/whisper-base', label: 'Base (multilingual)', multilingual: true, approxMb: 75 },
  { id: 'Xenova/whisper-small', label: 'Small (multilingual)', multilingual: true, approxMb: 250 },
];

export const DEFAULT_MODEL = 'Xenova/whisper-base.en';

export function findModel(id: string): WhisperModelInfo | undefined {
  return WHISPER_MODELS.find((m) => m.id === id);
}
