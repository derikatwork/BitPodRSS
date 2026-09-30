import { useState } from 'react';
import { activeChapterIndex, formatTime } from '../../../shared/transcript';
import { Icon } from '../../components/Icon';
import { BACK_SECONDS, FORWARD_SECONDS, usePlayer } from '../../state/player';
import { useNav } from '../../state/nav';
import { useSettings } from '../../state/settings';
import { BoostDialog } from './BoostDialog';
import { useChapters } from './useChapters';
import { useEpisodeValue } from './useEpisodeValue';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

/** The podcast player bar. Shown whenever an episode is loaded. */
export function Player() {
  const p = usePlayer();
  const rate = useSettings((s) => s.playbackRate);
  const streaming = useSettings((s) => s.v4v.streaming);
  const satsPerMinute = useSettings((s) => s.v4v.satsPerMinute);
  const go = useNav((s) => s.go);
  const { chapters } = useChapters(p.episodeId);
  const { value } = useEpisodeValue(p.episodeId);
  const [boosting, setBoosting] = useState(false);

  if (!p.episodeId) return null;
  const chapter = chapters[activeChapterIndex(chapters, p.position)];
  const max = p.duration || 0;

  return (
    <div className="player" role="region" aria-label="Podcast player">
      <div className="row" style={{ minWidth: 0 }}>
        {p.imageUrl ? <img className="cover sm" src={p.imageUrl} alt="" referrerPolicy="no-referrer" /> : <div className="cover sm" />}
        <button className="btn ghost" style={{ minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', padding: '2px 6px', textAlign: 'left' }} onClick={() => go('podcasts', { podcastId: p.podcastId, episodeId: p.episodeId })} title="Show this episode">
          <span className="ellipsis small" style={{ fontWeight: 600, maxWidth: '100%' }}>{p.title}</span>
          <span className="ellipsis tiny muted" style={{ maxWidth: '100%' }}>{chapter ? `${chapter.title} · ` : ''}{p.podcastTitle}</span>
        </button>
      </div>

      <div className="scrub-wrap stack" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn icon ghost" onClick={() => p.skip(-BACK_SECONDS)} aria-label={`Back ${BACK_SECONDS} seconds`} title={`Back ${BACK_SECONDS}s`}>
            <Icon name="rewind" />
          </button>
          <button className="btn icon primary" style={{ width: 40, height: 40, borderRadius: 20 }} onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'}>
            <Icon name={p.buffering && !p.playing ? 'refresh' : p.playing ? 'pause' : 'play'} size={20} />
          </button>
          <button className="btn icon ghost" onClick={() => p.skip(FORWARD_SECONDS)} aria-label={`Forward ${FORWARD_SECONDS} seconds`} title={`Forward ${FORWARD_SECONDS}s`}>
            <Icon name="fastforward" />
          </button>
        </div>
        <div className="scrub">
          <span>{formatTime(p.position)}</span>
          <input type="range" min={0} max={max || 1} step={1} value={Math.min(p.position, max || 1)} onChange={(e) => p.seek(Number(e.target.value))} aria-label="Seek" aria-valuetext={`${formatTime(p.position)} of ${formatTime(max)}`} disabled={!max} />
          <span>{formatTime(max)}</span>
        </div>
      </div>

      <div className="row extras" style={{ justifyContent: 'flex-end' }}>
        {streaming && value && (
          <span className="badge" title={`Streaming ${satsPerMinute} sats per minute to this show`}>
            <Icon name="zap" size={12} /> {satsPerMinute}/min
          </span>
        )}
        {value && (
          <button className="btn" onClick={() => setBoosting(true)}>
            <Icon name="zap" size={16} /> Boost
          </button>
        )}
        <select className="select" style={{ width: 'auto' }} value={rate} onChange={(e) => p.setRate(Number(e.target.value))} aria-label="Playback speed">
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        <button className="btn icon ghost" onClick={p.stop} aria-label="Close player">
          <Icon name="x" />
        </button>
      </div>
      {boosting && p.episodeId && <BoostDialog episodeId={p.episodeId} onClose={() => setBoosting(false)} />}
    </div>
  );
}
