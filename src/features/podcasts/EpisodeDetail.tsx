import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { activeChapterIndex, formatTime } from '../../../shared/transcript';
import { displayHost } from '../../../shared/url';
import { Icon } from '../../components/Icon';
import { db } from '../../db';
import { formatDuration, timeAgo } from '../../lib/format';
import { sanitizeHtml } from '../../lib/sanitize';
import { publishNote } from '../../lib/nostr';
import { useNostr } from '../../state/nostr';
import { usePlayer } from '../../state/player';
import { errorMessage, toast } from '../../state/toasts';
import { BoostDialog } from './BoostDialog';
import { QueueMenu } from './QueueMenu';
import { TranscriptPanel } from './TranscriptPanel';
import { useChapters } from './useChapters';
import { useEpisodeValue } from './useEpisodeValue';

type Tab = 'notes' | 'transcript' | 'chapters';

export function EpisodeDetail({ episodeId, onBack, onOpenPodcast }: { episodeId: number; onBack: () => void; onOpenPodcast: (podcastId: number) => void }) {
  const { episode, podcast, value } = useEpisodeValue(episodeId);
  const funding = useLiveQuery(async () => (await db.episodes.get(episodeId))?.meta?.funding ?? [], [episodeId]) ?? [];
  const [tab, setTab] = useState<Tab>('notes');
  const [boosting, setBoosting] = useState(false);
  const { chapters } = useChapters(episodeId);
  const player = usePlayer();
  const nostr = useNostr();
  const isCurrent = player.episodeId === episodeId;

  const notes = useMemo(() => (episode?.contentHtml ? sanitizeHtml(episode.contentHtml) : ''), [episode?.contentHtml]);
  if (!episode) return null;

  const activeChapter = isCurrent ? activeChapterIndex(chapters, player.position) : -1;
  const jump = (t: number) => (isCurrent ? player.seek(t) : void player.play(episodeId, { startAt: t }));
  const meta = episode.meta;
  const allFunding = [...funding, ...(podcast?.meta?.funding ?? [])];

  const share = async () => {
    try {
      const text = `🎧 ${episode.title}${podcast ? ` — ${podcast.title}` : ''}${episode.link ? `\n${episode.link}` : ''}`;
      const r = await publishNote(text, episode.link ? [['r', episode.link]] : []);
      if (r.ok.length === 0) throw new Error('None of the Nostr relays accepted the note. Check your connection and try again.');
      toast.ok(`Shared to ${r.ok.length} relay${r.ok.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <button className="btn ghost" onClick={onBack} style={{ marginBottom: 8 }}>
        <Icon name="chevron-left" /> Back
      </button>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        {(episode.imageUrl ?? podcast?.imageUrl) && <img className="cover lg mobile-hide" src={episode.imageUrl ?? podcast?.imageUrl} alt="" referrerPolicy="no-referrer" />}
        <div className="grow stack" style={{ gap: 6 }}>
          {podcast && (
            <button className="btn ghost" style={{ padding: 0, justifyContent: 'flex-start', color: 'var(--accent)' }} onClick={() => onOpenPodcast(podcast.id)}>
              {podcast.title}
            </button>
          )}
          <h1 style={{ fontSize: 24 }}>{episode.title}</h1>
          <div className="small muted row wrap" style={{ gap: 6 }}>
            <span>{timeAgo(episode.publishedAt)}</span>
            {episode.duration ? <span>· {formatDuration(episode.duration)}</span> : null}
            {meta?.season != null && <span>· Season {meta.season}{meta.seasonName ? ` (${meta.seasonName})` : ''}</span>}
            {meta?.episode != null && <span>· Episode {meta.episodeDisplay ?? meta.episode}</span>}
            {meta?.explicit && <span className="badge">Explicit</span>}
          </div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button className="btn primary big" onClick={() => (isCurrent ? player.toggle() : void player.play(episodeId))}>
              <Icon name={isCurrent && player.playing ? 'pause' : 'play'} /> {isCurrent && player.playing ? 'Pause' : episode.position > 5 && !episode.played ? 'Resume' : 'Play'}
            </button>
            <QueueMenu episodeId={episodeId} label="Queue" />
            {value && (
              <button className="btn big" onClick={() => setBoosting(true)}>
                <Icon name="zap" /> Boost
              </button>
            )}
            {nostr.mode === 'signer' && (
              <button className="btn big" onClick={() => void share()} title="Post this episode as a note on Nostr (your signer will ask you to approve)">
                Share on Nostr
              </button>
            )}
            {episode.link && (
              <a className="btn big" href={episode.link} target="_blank" rel="noopener noreferrer">
                <Icon name="external" /> {displayHost(episode.link)}
              </a>
            )}
          </div>
        </div>
      </div>

      {(meta?.persons.length || podcast?.meta?.persons.length) ? (
        <div className="row wrap small" style={{ marginTop: 14 }}>
          {[...(meta?.persons ?? []), ...(meta?.persons.length ? [] : (podcast?.meta?.persons ?? []))].map((p, i) => (
            <span key={i} className="badge">
              {p.img && <img className="favicon" src={p.img} alt="" referrerPolicy="no-referrer" />}
              {p.href ? (
                <a href={p.href} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                  {p.name}
                </a>
              ) : (
                p.name
              )}
              {p.role && <span className="muted">· {p.role}</span>}
            </span>
          ))}
        </div>
      ) : null}

      {meta && meta.soundbites.length > 0 && (
        <div className="row wrap small" style={{ marginTop: 12 }}>
          <span className="muted">Highlights:</span>
          {meta.soundbites.map((s, i) => (
            <button key={i} className="btn" style={{ padding: '2px 8px' }} onClick={() => jump(s.startTime)}>
              <Icon name="play" size={12} /> {s.title || `Clip ${i + 1}`} <span className="muted">{formatTime(s.startTime)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tabs" role="tablist" style={{ padding: 0, marginTop: 16 }}>
        {(['notes', 'transcript', 'chapters'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'notes' ? 'Show notes' : t === 'transcript' ? 'Transcript' : `Chapters${chapters.length ? ` (${chapters.length})` : ''}`}
          </button>
        ))}
      </div>

      <div style={{ paddingTop: 16 }}>
        {tab === 'notes' &&
          (notes ? <div className="prose" dangerouslySetInnerHTML={{ __html: notes }} /> : <p className="secondary">{episode.summary || 'No show notes.'}</p>)}
        {tab === 'transcript' && <TranscriptPanel episode={episode} />}
        {tab === 'chapters' &&
          (chapters.length === 0 ? (
            <p className="muted">This episode has no chapters.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {chapters.filter((c) => c.toc !== false).map((c) => {
                const i = chapters.indexOf(c);
                return (
                  <li key={i}>
                    <button className={`cue${i === activeChapter ? ' active' : ''}`} onClick={() => jump(c.startTime)}>
                      <time>{formatTime(c.startTime)}</time>
                      <span>{c.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>

      {allFunding.length > 0 && (
        <div className="row wrap small" style={{ marginTop: 20 }}>
          <span className="muted">Support:</span>
          {allFunding.map((f, i) => (
            <a key={i} className="btn" href={f.url} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={14} /> {f.text || displayHost(f.url)}
            </a>
          ))}
        </div>
      )}
      {boosting && <BoostDialog episodeId={episodeId} onClose={() => setBoosting(false)} />}
    </div>
  );
}
