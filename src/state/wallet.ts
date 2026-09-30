import { create } from 'zustand';
import { connectNwc, connectWebLN, isNwcUrl, weblnAvailable, type WalletInfo, type WalletProvider } from '../lib/wallet';
import { safeStorage } from './settings';
import { errorMessage } from './toasts';

const KEY = 'bitpodrss.wallet';

interface Saved {
  kind: 'webln' | 'nwc';
  /** The Nostr Wallet Connect string. It can spend from the wallet, so it is stored only in this browser. */
  nwcUrl?: string;
}

function load(): Saved | undefined {
  try {
    const raw = safeStorage().getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}

function save(v: Saved | undefined): void {
  try {
    if (v) safeStorage().setItem(KEY, JSON.stringify(v));
    else safeStorage().removeItem(KEY);
  } catch {
    // Not persisting is acceptable; the wallet just will not reconnect on reload.
  }
}

interface WalletState {
  status: 'disconnected' | 'connecting' | 'connected';
  kind?: 'webln' | 'nwc';
  info?: WalletInfo;
  balanceSats?: number;
  error?: string;
  /** True when a saved connection exists and will be restored on load. */
  hasSaved: boolean;
  connectWebLN: () => Promise<void>;
  connectNwc: (url: string) => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  restore: () => Promise<void>;
}

let provider: WalletProvider | undefined;

/** The connected wallet, if any. Kept outside React state because it holds live connections. */
export function getWallet(): WalletProvider | undefined {
  return provider;
}

export const useWallet = create<WalletState>((set, get) => {
  const adopt = async (p: WalletProvider, saved: Saved): Promise<void> => {
    provider?.close();
    provider = p;
    const info = await p.getInfo().catch(() => ({}) as WalletInfo);
    const balanceSats = await p.getBalanceSats().catch(() => undefined);
    save(saved);
    set({ status: 'connected', kind: p.kind, info, balanceSats, error: undefined, hasSaved: true });
  };

  return {
    status: 'disconnected',
    hasSaved: !!load(),

    async connectWebLN() {
      set({ status: 'connecting', error: undefined });
      try {
        await adopt(await connectWebLN(), { kind: 'webln' });
      } catch (err) {
        set({ status: 'disconnected', error: errorMessage(err) });
      }
    },

    async connectNwc(url) {
      set({ status: 'connecting', error: undefined });
      try {
        if (!isNwcUrl(url)) throw new Error('That does not look like a Nostr Wallet Connect string. It should start with nostr+walletconnect://');
        const p = await connectNwc(url);
        // Prove the connection works (and the relay and wallet answer) before saving it.
        await p.getInfo();
        await adopt(p, { kind: 'nwc', nwcUrl: url.trim() });
      } catch (err) {
        set({ status: 'disconnected', error: errorMessage(err) });
      }
    },

    disconnect() {
      provider?.close();
      provider = undefined;
      save(undefined);
      set({ status: 'disconnected', kind: undefined, info: undefined, balanceSats: undefined, error: undefined, hasSaved: false });
    },

    async refreshBalance() {
      if (!provider) return;
      try {
        set({ balanceSats: await provider.getBalanceSats() });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async restore() {
      const saved = load();
      if (!saved || get().status !== 'disconnected') return;
      if (saved.kind === 'webln') {
        // Only reconnect silently if the extension is already there; never pop a prompt on page load.
        if (weblnAvailable()) await get().connectWebLN();
      } else if (saved.nwcUrl) await get().connectNwc(saved.nwcUrl);
    },
  };
});
