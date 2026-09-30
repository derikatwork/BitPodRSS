import { useMemo } from 'react';
import { rankVoices } from '../../../shared/speech';
import { Icon } from '../../components/Icon';
import { useSettings } from '../../state/settings';
import { useTts } from '../../state/tts';

/** Shown while an article is being read aloud. Voice and speed changes apply immediately. */
export function TtsBar() {
  const { status, title, chunks, index, voices, toggle, stop, skip } = useTts();
  const rate = useSettings((s) => s.ttsRate);
  const voiceURI = useSettings((s) => s.ttsVoiceURI);
  const preferLocal = useSettings((s) => s.ttsPreferLocal);
  const set = useSettings((s) => s.set);
  const ranked = useMemo(() => rankVoices(voices, { lang: navigator.language, preferLocal }), [voices, preferLocal]);

  if (status === 'idle') return null;
  const current = chunks[index]?.text ?? '';
  const pct = chunks.length ? Math.round(((index + 1) / chunks.length) * 100) : 0;

  return (
    <div className="tts-bar" role="region" aria-label="Read aloud">
      <Icon name="headphones" />
      <div className="grow">
        <div className="small" style={{ fontWeight: 600 }}>
          <span className="ellipsis" style={{ display: 'block' }}>{title}</span>
        </div>
        <div className="tiny secondary ellipsis" aria-live="off">
          {status === 'loading' ? 'Fetching the article…' : current}
        </div>
        {status !== 'loading' && (
          <div className="progress-bar" style={{ marginTop: 4, height: 3 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reading progress">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <button className="btn icon ghost" onClick={() => skip(-1)} disabled={status === 'loading'} aria-label="Previous sentence">
        <Icon name="rewind" />
      </button>
      <button className="btn icon primary" onClick={toggle} disabled={status === 'loading'} aria-label={status === 'speaking' ? 'Pause' : 'Resume'}>
        <Icon name={status === 'speaking' ? 'pause' : 'play'} />
      </button>
      <button className="btn icon ghost" onClick={() => skip(1)} disabled={status === 'loading'} aria-label="Next sentence">
        <Icon name="fastforward" />
      </button>
      <select className="select mobile-hide" style={{ width: 'auto', maxWidth: 200 }} value={voiceURI ?? ''} onChange={(e) => set({ ttsVoiceURI: e.target.value || undefined })} aria-label="Voice">
        <option value="">Best available voice</option>
        {ranked.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>
            {v.name} ({v.lang}){v.localService ? '' : ' · cloud'}
          </option>
        ))}
      </select>
      <select className="select" style={{ width: 'auto' }} value={rate} onChange={(e) => set({ ttsRate: Number(e.target.value) })} aria-label="Speaking speed">
        {[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      <button className="btn icon ghost" onClick={stop} aria-label="Stop reading">
        <Icon name="x" />
      </button>
    </div>
  );
}
