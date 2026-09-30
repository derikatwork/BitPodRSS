import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Capabilities, TranscriptRef } from '../../../shared/types';
import { activeSegmentIndex, formatTime, parseTranscript, toPlainText, toSrt, toVtt } from '../../../shared/transcript';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { db, type Episode } from '../../db';
import { usePlayer } from '../../state/player';
import { useSettings } from '../../state/settings';
import { errorMessage } from '../../state/toasts';
import { saveTranscript, useTranscribe } from '../../state/transcribe';

/** Preference order when a feed offers several formats: timed, structured formats first. */
function rankRef(r: TranscriptRef): number {
  const t = r.type.toLowerCase();
  if (t.includes('json')) return 0;
  if (t.includes('vtt')) return 1;
  if (t.includes('srt') || t.includes('subrip')) return 2;
  if (t.includes('html')) return 3;
  return 4;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TranscriptPanel({ episode }: { episode: Episode }) {
  // useLiveQuery yields `undefined` both while loading and when nothing matches, so "none stored" is mapped to
  // `null` to tell the two apart: without that, a missing transcript would look like "still loading" forever.
  const result = useLiveQuery(async () => (await db.transcripts.where('episodeId').equals(episode.id).first()) ?? null, [episode.id]);
  const loaded = result !== undefined;
  const stored = result ?? undefined;
  const job = useTranscribe((s) => s.jobs[episode.id]);
  const startJob = useTranscribe((s) => s.start);
  const cancelJob = useTranscribe((s) => s.cancel);
  const dismissJob = useTranscribe((s) => s.dismiss);
  const model = useSettings((s) => s.whisperModel);
  const language = useSettings((s) => s.transcribeLanguage);
  const setSettings = useSettings((s) => s.set);

  const [caps, setCaps] = useState<(Capabilities & { defaultModel: string }) | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const triedAuto = useRef<number | null>(null);

  const refs = useMemo(() => [...(episode.meta?.transcripts ?? [])].sort((a, b) => rankRef(a) - rankRef(b)), [episode.meta]);

  const loadPublisher = async (): Promise<void> => {
    setFetching(true);
    setFetchError(null);
    let lastError: unknown;
    for (const ref of refs) {
      try {
        const t = parseTranscript(await api.text(ref.url), ref.type || ref.url);
        if (t.segments.length) {
          await saveTranscript(episode.id, t, { source: 'publisher', language: ref.language });
          setFetching(false);
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }
    setFetchError(lastError ? `Could not load the publisher's transcript: ${errorMessage(lastError)}` : 'The publisher transcript was empty.');
    setFetching(false);
  };

  // Fetch the publisher's transcript automatically the first time this panel opens for an episode.
  useEffect(() => {
    if (loaded && !stored && refs.length && triedAuto.current !== episode.id) {
      triedAuto.current = episode.id;
      void loadPublisher();
    }
  }, [loaded, stored, episode.id]);

  useEffect(() => {
    api.capabilities().then(setCaps).catch((e: unknown) => setCapsError(errorMessage(e)));
  }, []);

  const playing = usePlayer((s) => s.episodeId === episode.id);
  const position = usePlayer((s) => (s.episodeId === episode.id ? s.position : -1));
  const seek = usePlayer((s) => s.seek);
  const play = usePlayer((s) => s.play);

  const segments = stored?.segments ?? (job?.segments.length ? job.segments : []);
  const timed = stored ? stored.timed : true;
  const active = timed && playing ? activeSegmentIndex(segments, position) : -1;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const q = filter.trim().toLowerCase();
  const visible = segments.map((s, i) => ({ s, i })).filter(({ s }) => !q || s.text.toLowerCase().includes(q) || s.speaker?.toLowerCase().includes(q));

  const jumpTo = (t: number): void => {
    if (!timed) return;
    if (playing) seek(t);
    else void play(episode.id, { startAt: t });
  };

  const modelInfo = caps?.whisper.models.find((m) => m.id === model);
  const canTranscribe = caps?.ffmpeg.available && caps.whisper.available;
  const running = job && (job.status === 'starting' || job.status === 'queued' || job.status === 'downloading' || job.status === 'transcribing');
  const base = episode.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'transcript';

  return (
    <div className="stack">
      {stored && (
        <div className="row wrap small">
          <span className="badge">{stored.source === 'local' ? `Transcribed on this device${stored.model ? ` (${stored.model.replace('Xenova/whisper-', 'Whisper ')})` : ''}` : 'From the publisher'}</span>
          <div className="grow" />
          <input className="input" style={{ width: 180 }} placeholder="Search transcript" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search transcript" />
          <button className="btn" onClick={() => download(`${base}.vtt`, toVtt(stored.segments), 'text/vtt')} disabled={!stored.timed}>
            <Icon name="download" size={15} /> VTT
          </button>
          <button className="btn" onClick={() => download(`${base}.srt`, toSrt(stored.segments), 'application/x-subrip')} disabled={!stored.timed}>
            SRT
          </button>
          <button className="btn" onClick={() => download(`${base}.txt`, toPlainText(stored.segments), 'text/plain')}>
            TXT
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm('Delete this transcript?')) void db.transcripts.delete(stored.id);
            }}
            aria-label="Delete transcript"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      )}

      {fetching && <div className="notice">Loading the publisher’s transcript…</div>}
      {fetchError && <div className="notice warn">{fetchError}</div>}

      {segments.length > 0 ? (
        <div className="transcript" ref={listRef} role="list" aria-label="Transcript">
          {visible.length === 0 && <div className="muted small">No matches.</div>}
          {visible.map(({ s, i }) => (
            <button key={i} role="listitem" data-cue={i} className={`cue${i === active ? ' active' : ''}`} onClick={() => jumpTo(s.start)} disabled={!timed} style={!timed ? { cursor: 'default' } : undefined}>
              {timed && <time>{formatTime(s.start)}</time>}
              <span>
                {s.speaker && <strong>{s.speaker}: </strong>}
                {s.text}
              </span>
            </button>
          ))}
        </div>
      ) : (
        !fetching &&
        !running && (
          <div className="muted small">
            {refs.length ? 'No transcript loaded yet.' : 'This episode’s feed does not include a transcript. You can create one on your own computer below.'}
          </div>
        )
      )}

      <div className="card stack" style={{ background: 'var(--surface-2)' }}>
        <div className="row">
          <Icon name="captions" />
          <strong>Transcribe on this computer</strong>
        </div>
        <p className="small secondary" style={{ margin: 0 }}>
          Uses the open-source Whisper speech model running on the machine where BitPodRSS is installed. The audio is never sent to a third party (the model itself is downloaded once on first use).
        </p>

        {capsError && <div className="notice error">{capsError}</div>}
        {caps && !caps.ffmpeg.available && (
          <div className="notice warn">
            <strong>ffmpeg is required.</strong> Install it (for example <code>brew install ffmpeg</code> or <code>sudo apt install ffmpeg</code>) and restart the server.
          </div>
        )}
        {caps && !caps.whisper.available && (
          <div className="notice warn">
            <strong>The speech engine is not available.</strong> {caps.whisper.reason}
          </div>
        )}

        {!running && (
          <div className="row wrap">
            <select className="select" style={{ width: 'auto' }} value={model} onChange={(e) => setSettings({ whisperModel: e.target.value })} aria-label="Speech model">
              {(caps?.whisper.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · ~{m.approxMb} MB
                </option>
              ))}
              {!caps && <option value={model}>{model}</option>}
            </select>
            {modelInfo?.multilingual && (
              <input className="input" style={{ width: 120 }} value={language} onChange={(e) => setSettings({ transcribeLanguage: e.target.value.trim().toLowerCase() })} placeholder="Language (auto)" maxLength={3} aria-label="Language code" />
            )}
            <button className="btn primary" disabled={!canTranscribe} onClick={() => void startJob(episode.id, { model, language })}>
              {stored ? 'Re-transcribe' : 'Transcribe'}
            </button>
          </div>
        )}

        {job && (
          <div className="stack" style={{ gap: 6 }} aria-live="polite">
            <div className="row small">
              <span className="grow">
                {job.status === 'error' ? <span style={{ color: 'var(--bad)' }}>Failed: {job.error}</span> : job.status === 'cancelled' ? 'Cancelled.' : (job.message ?? 'Starting…')}
              </span>
              {running && (
                <button className="btn" onClick={() => void cancelJob(episode.id)}>
                  Cancel
                </button>
              )}
              {(job.status === 'error' || job.status === 'cancelled') && (
                <button className="btn" onClick={() => dismissJob(episode.id)}>
                  Dismiss
                </button>
              )}
            </div>
            {running && (
              <div className="progress-bar" role="progressbar" aria-valuenow={Math.round((job.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Transcription progress">
                <div style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
              </div>
            )}
            {running && job.status === 'transcribing' && <div className="tiny muted">Text appears above as it is produced. You can leave this page; it keeps running.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
