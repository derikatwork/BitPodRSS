import { Suspense, lazy, useEffect } from 'react';
import { computeChanges, formatPct, formatPrice } from '../shared/btc';
import { Icon, type IconName } from './components/Icon';
import { Toasts } from './components/Toasts';
import { useBtc } from './features/bitcoin/useBtc';
import { Player } from './features/podcasts/Player';
import { useStreamingSats } from './features/podcasts/useStreaming';
import { ReaderPage } from './features/reader/ReaderPage';
import { TtsBar } from './features/reader/TtsBar';
import { refreshAll } from './lib/ingest';
import { formatSats } from './lib/format';
import { useNav, type Page } from './state/nav';
import { useNostr } from './state/nostr';
import { useSettings } from './state/settings';
import { useTts } from './state/tts';
import { useWallet } from './state/wallet';

// Secondary pages load on demand; the Reader is what most people open first.
const PodcastsPage = lazy(() => import('./features/podcasts/PodcastsPage').then((m) => ({ default: m.PodcastsPage })));
const WalletPage = lazy(() => import('./features/wallet/WalletPage').then((m) => ({ default: m.WalletPage })));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const NAV: { id: Page; label: string; icon: IconName }[] = [
  { id: 'reader', label: 'Reader', icon: 'rss' },
  { id: 'podcasts', label: 'Podcasts', icon: 'mic' },
  { id: 'wallet', label: 'Bitcoin', icon: 'zap' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const TITLES: Record<Page, string> = { reader: 'Reader', podcasts: 'Podcasts', wallet: 'Bitcoin & wallet', settings: 'Settings' };

function useTheme(): void {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

/** Refresh all subscriptions on load and then on the user's chosen interval, while the app is open. */
function useAutoRefresh(): void {
  const minutes = useSettings((s) => s.refreshMinutes);
  useEffect(() => {
    if (!minutes) return;
    const run = () => void refreshAll().catch(() => undefined);
    const first = setTimeout(run, 1500);
    const timer = setInterval(run, minutes * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [minutes]);
}

function PriceChip() {
  const currency = useSettings((s) => s.currency);
  const go = useNav((s) => s.go);
  const { data } = useBtc(currency);
  if (!data) return null;
  const week = computeChanges(data)['1W'];
  const up = week.pct > 0;
  return (
    <button className="chip" onClick={() => go('wallet')} title="Bitcoin price and 1-week change" aria-label={`Bitcoin ${formatPrice(data.current, data.currency)}, ${formatPct(week.pct)} over one week`}>
      <span style={{ color: '#f7931a', fontWeight: 700 }} aria-hidden="true">
        ₿
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPrice(data.current, data.currency, true)}</span>
      <span className={`delta ${up ? 'up' : week.pct < 0 ? 'down' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {week.pct !== 0 && <Icon name={up ? 'trend-up' : 'trend-down'} size={14} />}
        {formatPct(week.pct)} <span className="muted">1W</span>
      </span>
    </button>
  );
}

export function App() {
  const page = useNav((s) => s.page);
  const go = useNav((s) => s.go);
  const wallet = useWallet();
  const nostr = useNostr();
  useTheme();
  useAutoRefresh();
  useStreamingSats();

  const initTts = useTts((s) => s.init);
  useEffect(() => {
    void initTts();
    void useWallet.getState().restore();
    void useNostr.getState().refreshProfile();
  }, [initTts]);

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="nav-logo" aria-hidden="true">
          <Icon name="rss" size={22} />
        </div>
        {NAV.map((n) => (
          <button key={n.id} aria-current={page === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
            <Icon name={n.icon} size={20} />
            {n.label}
          </button>
        ))}
        <div className="spacer" />
      </nav>
      <main className="main">
        <header className="topbar">
          <h1 className="grow">{TITLES[page]}</h1>
          <PriceChip />
          {wallet.status === 'connected' && (
            <button className="chip" onClick={() => go('wallet')} title="Lightning wallet">
              <Icon name="wallet" size={14} /> {wallet.balanceSats !== undefined ? formatSats(wallet.balanceSats) : 'Connected'}
            </button>
          )}
          {nostr.pubkey && (
            <button className="chip" onClick={() => go('settings')} title="Nostr identity">
              {nostr.profile?.picture ? <img className="favicon" style={{ borderRadius: '50%' }} src={nostr.profile.picture} alt="" referrerPolicy="no-referrer" /> : <Icon name="user" size={14} />}
              <span className="mobile-hide">{nostr.profile?.displayName ?? nostr.profile?.name ?? 'Nostr'}</span>
            </button>
          )}
        </header>
        <div className="page">
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {page === 'reader' && <ReaderPage />}
            {page === 'podcasts' && <PodcastsPage />}
            {page === 'wallet' && <WalletPage />}
            {page === 'settings' && <SettingsPage />}
          </Suspense>
        </div>
      </main>
      <div className="dock">
        <TtsBar />
        <Player />
      </div>
      <Toasts />
    </div>
  );
}
