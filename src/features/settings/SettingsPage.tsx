import { useEffect, useMemo, useState } from 'react';
import { rankVoices } from '../../../shared/speech';
import type { Capabilities } from '../../../shared/types';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { ImportOpmlDialog, downloadOpml } from '../../components/OpmlDialog';
import { db } from '../../db';
import { truncateMiddle } from '../../lib/format';
import { nip07Available } from '../../lib/nostr';
import { previewVoice } from '../../lib/tts';
import { useNostr } from '../../state/nostr';
import { useSettings, type Theme } from '../../state/settings';
import { errorMessage, toast } from '../../state/toasts';
import { useTts } from '../../state/tts';

export function SettingsPage() {
  return (
    <div className="container stack" style={{ gap: 20 }}>
      <h1 style={{ fontSize: 24 }}>Settings</h1>
      <AppearanceCard />
      <FeedsCard />
      <SpeechCard />
      <TranscriptionCard />
      <IdentityCard />
      <DataCard />
    </div>
  );
}

function Card({ title, icon, children, id }: { title: string; icon: React.ComponentProps<typeof Icon>['name']; children: React.ReactNode; id: string }) {
  return (
    <section className="card stack" aria-labelledby={id}>
      <div className="row">
        <Icon name={icon} />
        <h2 id={id} style={{ fontSize: 17 }}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function AppearanceCard() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  return (
    <Card id="s-appearance" title="Appearance" icon="sun">
      <div className="seg" role="group" aria-label="Theme" style={{ alignSelf: 'flex-start' }}>
        {(['system', 'light', 'dark'] as Theme[]).map((t) => (
          <button key={t} aria-pressed={theme === t} onClick={() => set({ theme: t })}>
            {t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>
    </Card>
  );
}

function FeedsCard() {
  const refreshMinutes = useSettings((s) => s.refreshMinutes);
  const set = useSettings((s) => s.set);
  const [importing, setImporting] = useState(false);
  return (
    <Card id="s-feeds" title="Feeds & podcasts" icon="rss">
      <label className="field" style={{ maxWidth: 320 }}>
        Check for new items
        <select className="select" value={refreshMinutes} onChange={(e) => set({ refreshMinutes: Number(e.target.value) })}>
          <option value={0}>Only when I refresh</option>
          <option value={15}>Every 15 minutes</option>
          <option value={30}>Every 30 minutes</option>
          <option value={60}>Every hour</option>
          <option value={180}>Every 3 hours</option>
        </select>
        <span className="tiny muted">Runs while BitPodRSS is open.</span>
      </label>
      <div className="row wrap">
        <button className="btn" onClick={() => setImporting(true)}>
          <Icon name="upload" size={16} /> Import OPML
        </button>
        <button className="btn" onClick={() => void downloadOpml().catch((e: unknown) => toast.error(errorMessage(e)))}>
          <Icon name="download" size={16} /> Export OPML
        </button>
      </div>
      {importing && <ImportOpmlDialog onClose={() => setImporting(false)} />}
    </Card>
  );
}

function SpeechCard() {
  const { voices, supported, init } = useTts();
  const voiceURI = useSettings((s) => s.ttsVoiceURI);
  const rate = useSettings((s) => s.ttsRate);
  const preferLocal = useSettings((s) => s.ttsPreferLocal);
  const set = useSettings((s) => s.set);
  useEffect(() => void init(), [init]);
  const ranked = useMemo(() => rankVoices(voices, { lang: navigator.language, preferLocal }), [voices, preferLocal]);
  const chosen = ranked.find((v) => v.voiceURI === voiceURI) ?? ranked[0];

  return (
    <Card id="s-speech" title="Read aloud" icon="headphones">
      {!supported ? (
        <div className="notice warn">This browser does not support speech synthesis. Try Chrome, Edge, Safari or Firefox.</div>
      ) : (
        <>
          <p className="small secondary" style={{ margin: 0 }}>
            Articles are read with your device’s voices. Voices marked “cloud” send the text to the browser vendor’s speech service; tick “prefer on-device” to avoid that. Newer “Natural”, “Neural” and “Enhanced” voices sound best; you may be able to add more in your operating system’s speech settings.
          </p>
          <label className="field" style={{ maxWidth: 420 }}>
            Voice
            <select className="select" value={voiceURI ?? ''} onChange={(e) => set({ ttsVoiceURI: e.target.value || undefined })}>
              <option value="">Best available ({chosen?.name ?? 'default'})</option>
              {ranked.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang}){v.localService ? '' : ' · cloud'}
                </option>
              ))}
            </select>
          </label>
          <label className="switch">
            <input type="checkbox" checked={preferLocal} onChange={(e) => set({ ttsPreferLocal: e.target.checked })} /> Prefer on-device voices
          </label>
          <div className="row wrap">
            <label className="field">
              Speed
              <select className="select" style={{ width: 'auto' }} value={rate} onChange={(e) => set({ ttsRate: Number(e.target.value) })}>
                {[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => previewVoice(chosen, rate)}>
              <Icon name="volume" size={16} /> Preview
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

function TranscriptionCard() {
  const model = useSettings((s) => s.whisperModel);
  const language = useSettings((s) => s.transcribeLanguage);
  const set = useSettings((s) => s.set);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.capabilities().then(setCaps).catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  const info = caps?.whisper.models.find((m) => m.id === model);

  const status = (ok: boolean | undefined, label: string) => (
    <span className="badge" style={{ color: ok ? 'var(--good)' : ok === false ? 'var(--bad)' : undefined }}>
      <Icon name={ok ? 'check' : 'x'} size={12} /> {label}
    </span>
  );

  return (
    <Card id="s-transcribe" title="Local transcription" icon="captions">
      <p className="small secondary" style={{ margin: 0 }}>
        Podcasts are transcribed on the computer running BitPodRSS using the open-source Whisper model. It needs <strong>ffmpeg</strong> and the optional <code>@huggingface/transformers</code> package; the model (40–250 MB) is downloaded once, then everything works offline.
      </p>
      {error && <div className="notice error">{error}</div>}
      {caps && (
        <div className="row wrap small">
          {status(caps.ffmpeg.available, caps.ffmpeg.available ? 'ffmpeg found' : 'ffmpeg not found')}
          {status(caps.whisper.available, caps.whisper.available ? 'Speech engine ready' : 'Speech engine unavailable')}
        </div>
      )}
      {caps && !caps.whisper.available && caps.whisper.reason && <div className="notice warn">{caps.whisper.reason}</div>}
      <div className="row wrap">
        <label className="field">
          Model
          <select className="select" style={{ width: 'auto' }} value={model} onChange={(e) => set({ whisperModel: e.target.value })}>
            {(caps?.whisper.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · ~{m.approxMb} MB
              </option>
            ))}
            {!caps && <option value={model}>{model}</option>}
          </select>
        </label>
        {info?.multilingual && (
          <label className="field">
            Language (blank = detect)
            <input className="input" style={{ width: 140 }} value={language} onChange={(e) => set({ transcribeLanguage: e.target.value.trim().toLowerCase() })} placeholder="e.g. en, de, fr" maxLength={3} />
          </label>
        )}
      </div>
      {caps && <div className="tiny muted">Models and transcripts are stored in <span className="mono">{caps.whisper.dataDir}</span> on the server.</div>}
    </Card>
  );
}

function IdentityCard() {
  const nostr = useNostr();
  const [npubInput, setNpubInput] = useState('');
  const hasSigner = nip07Available();
  const name = nostr.profile?.displayName ?? nostr.profile?.name;

  return (
    <Card id="s-identity" title="Nostr identity (optional)" icon="user">
      <p className="small secondary" style={{ margin: 0 }}>
        Connect a Nostr profile if you want your name and public key attached to boosts, and to share episodes as notes. Everything in BitPodRSS works without one.
      </p>
      {nostr.pubkey ? (
        <div className="row wrap" style={{ gap: 14 }}>
          {nostr.profile?.picture ? <img className="avatar" src={nostr.profile.picture} alt="" referrerPolicy="no-referrer" /> : <div className="avatar" />}
          <div className="grow" style={{ minWidth: 200 }}>
            <div style={{ fontWeight: 600 }}>{name ?? 'Nostr user'}</div>
            <div className="mono small muted" title={nostr.npub}>
              {truncateMiddle(nostr.npub ?? '', 12)}
            </div>
            <div className="row wrap tiny" style={{ gap: 6, marginTop: 4 }}>
              <span className="badge">{nostr.mode === 'signer' ? 'Signer connected' : 'Read-only (npub)'}</span>
              {nostr.profile?.nip05 && <span className="badge">{nostr.profile.nip05}</span>}
              {nostr.profile?.lud16 && <span className="badge">⚡ {nostr.profile.lud16}</span>}
            </div>
          </div>
          <button className="btn" onClick={() => void nostr.refreshProfile(true)} disabled={nostr.loadingProfile}>
            <Icon name="refresh" size={16} /> {nostr.loadingProfile ? 'Loading…' : 'Refresh'}
          </button>
          <button className="btn" onClick={nostr.disconnect}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="grid-2">
          <div className="stack">
            <button className="btn primary" onClick={() => void nostr.connectSigner()} disabled={!hasSigner}>
              Connect with Nostr extension
            </button>
            <div className="tiny muted">{hasSigner ? 'Uses your NIP-07 signer (for example Alby). Your private key never leaves the extension.' : 'No NIP-07 extension detected. Install Alby or another signer, or use an npub below.'}</div>
          </div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (npubInput.trim()) void nostr.connectNpub(npubInput).then(() => setNpubInput(''));
            }}
          >
            <div className="row">
              <input className="input mono" value={npubInput} onChange={(e) => setNpubInput(e.target.value)} placeholder="npub1…" aria-label="Your npub" spellCheck={false} />
              <button className="btn" type="submit" disabled={!npubInput.trim()}>
                Use npub
              </button>
            </div>
            <div className="tiny muted">Public key only. Never paste a private key (nsec); it is rejected.</div>
          </form>
        </div>
      )}
      {nostr.error && <div className="notice error">{nostr.error}</div>}
    </Card>
  );
}

function DataCard() {
  const [busy, setBusy] = useState(false);
  const wipe = async () => {
    if (!confirm('Delete ALL subscriptions, articles, episodes, transcripts, queues, payment history and settings from this browser? This cannot be undone.')) return;
    setBusy(true);
    try {
      db.close();
      await db.delete();
      for (const key of Object.keys(localStorage)) if (key.startsWith('bitpodrss.')) localStorage.removeItem(key);
      location.reload();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Card id="s-data" title="Your data" icon="file">
      <p className="small secondary" style={{ margin: 0 }}>
        Subscriptions, articles, playback progress and transcripts are stored in this browser only. Your wallet connection and Nostr identity are also stored here, never on the server. Export OPML above to back up your subscriptions.
      </p>
      <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => void wipe()} disabled={busy}>
        <Icon name="trash" size={16} /> Delete all local data
      </button>
    </Card>
  );
}
