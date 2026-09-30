import { create } from 'zustand';
import { fetchProfile, getNip07Pubkey, npubOf, parsePubkey, type NostrProfile } from '../lib/nostr';
import { safeStorage } from './settings';
import { errorMessage } from './toasts';

const KEY = 'bitpodrss.nostr';
const PROFILE_TTL_MS = 24 * 3600_000;

interface Saved {
  pubkey: string;
  /** `signer` = connected through a NIP-07 extension (can sign); `readonly` = only an npub was provided. */
  mode: 'signer' | 'readonly';
  profile?: NostrProfile;
  profileAt?: number;
}

function load(): Saved | undefined {
  try {
    const raw = safeStorage().getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}

function persist(s: Saved | undefined): void {
  try {
    if (s) safeStorage().setItem(KEY, JSON.stringify(s));
    else safeStorage().removeItem(KEY);
  } catch {
    // ignore
  }
}

interface NostrState {
  pubkey?: string;
  npub?: string;
  mode?: 'signer' | 'readonly';
  profile?: NostrProfile;
  loadingProfile: boolean;
  error?: string;
  connectSigner: () => Promise<void>;
  connectNpub: (npub: string) => Promise<void>;
  disconnect: () => void;
  refreshProfile: (force?: boolean) => Promise<void>;
}

const saved = load();

/**
 * Optional Nostr identity. Nothing in the app requires it: when it is not connected every feature works the
 * same, and relay lookups only ever happen after the user connects.
 */
export const useNostr = create<NostrState>((set, get) => ({
  pubkey: saved?.pubkey,
  npub: saved ? npubOf(saved.pubkey) : undefined,
  mode: saved?.mode,
  profile: saved?.profile,
  loadingProfile: false,

  async connectSigner() {
    set({ error: undefined });
    try {
      const pubkey = await getNip07Pubkey();
      persist({ pubkey, mode: 'signer' });
      set({ pubkey, npub: npubOf(pubkey), mode: 'signer', profile: undefined });
      await get().refreshProfile(true);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async connectNpub(input) {
    set({ error: undefined });
    try {
      const pubkey = parsePubkey(input);
      persist({ pubkey, mode: 'readonly' });
      set({ pubkey, npub: npubOf(pubkey), mode: 'readonly', profile: undefined });
      await get().refreshProfile(true);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  disconnect() {
    persist(undefined);
    set({ pubkey: undefined, npub: undefined, mode: undefined, profile: undefined, error: undefined });
  },

  async refreshProfile(force = false) {
    const { pubkey, mode } = get();
    if (!pubkey || !mode) return;
    const cached = load();
    if (!force && cached?.profile && cached.profileAt && Date.now() - cached.profileAt < PROFILE_TTL_MS) return;
    set({ loadingProfile: true });
    try {
      const profile = await fetchProfile(pubkey);
      if (get().pubkey !== pubkey) return; // disconnected or switched meanwhile
      if (profile) {
        persist({ pubkey, mode, profile, profileAt: Date.now() });
        set({ profile });
      }
    } catch {
      // Relays are best-effort; the identity still works without a fetched profile.
    } finally {
      set({ loadingProfile: false });
    }
  },
}));
