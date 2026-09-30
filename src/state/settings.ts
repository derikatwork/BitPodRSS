import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_V4V, type V4vSettings } from '../lib/spending';

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  /** Fiat currency for Bitcoin prices. */
  currency: string;
  /** Background refresh interval in minutes; 0 disables it. */
  refreshMinutes: number;
  /** Collapse suspected duplicate articles into the first-seen copy. */
  hideDuplicates: boolean;
  ttsVoiceURI?: string;
  ttsRate: number;
  ttsPreferLocal: boolean;
  playbackRate: number;
  activeQueueId?: number;
  whisperModel: string;
  transcribeLanguage: string;
  /** Name sent with boosts. */
  senderName: string;
  v4v: V4vSettings;
}

const DEFAULTS: Settings = {
  theme: 'system',
  currency: 'usd',
  refreshMinutes: 30,
  hideDuplicates: false,
  ttsRate: 1,
  ttsPreferLocal: false,
  playbackRate: 1,
  whisperModel: 'Xenova/whisper-base.en',
  transcribeLanguage: '',
  senderName: '',
  v4v: DEFAULT_V4V,
};

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setV4v: (patch: Partial<V4vSettings>) => void;
}

/** localStorage can throw (private windows, blocked storage); the app must still run without it. */
export function safeStorage(): Storage {
  try {
    const probe = '__bitpod_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      get length() {
        return mem.size;
      },
      clear: () => mem.clear(),
      getItem: (k) => mem.get(k) ?? null,
      key: (i) => [...mem.keys()][i] ?? null,
      removeItem: (k) => void mem.delete(k),
      setItem: (k, v) => void mem.set(k, v),
    };
  }
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      setV4v: (patch) => set((s) => ({ v4v: { ...s.v4v, ...patch } })),
    }),
    {
      name: 'bitpodrss.settings',
      storage: createJSONStorage(safeStorage),
      version: 1,
      // Merge so settings added in later versions get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        return { ...current, ...p, v4v: { ...current.v4v, ...(p.v4v ?? {}) } };
      },
    },
  ),
);
