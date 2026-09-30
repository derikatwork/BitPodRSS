import { Icon } from '../../components/Icon';
import type { Episode, Podcast } from '../../db';
import { db } from '../../db';
import { formatDuration, timeAgo } from '../../lib/format';
import { usePlayer } from '../../state/player';
import { QueueMenu } from './QueueMenu';

interface Props {
  episode: Episode;
  podcast?: Podcast;
  /** Show the podcast's name and cover (for mixed lists such as "Latest episodes"). */
  showPodcast?: boolean;
  queueId?: number;
  onOpen: (episodeId: number) => void;
  /** Extra controls rendered at the end of the row (e.g. queue ordering buttons). */
  actions?: React.ReactNode;
}

export function EpisodeRow({ episode, podcast, showPodcast, queueId, onOpen, actions }: Props) {
  const current = usePlayer((s) => s.episodeId === episode.id);
  const playing = usePlayer((s) => s.episodeId === episode.id && s.playing);
  const play = usePlayer((s) => s.play);
  const toggle = usePlayer((s) => s.toggle);
  const hasTranscript = (episode.meta?.transcripts.length ?? 0) > 0;
  const hasValue = !!(episode.meta?.value ?? podcast?.meta?.value);
  const pct = episode.duration && episode.position ? Math.min(100, (episode.position / episode.duration) * 100) : 0;

  return (
    <div className={`episode${episode.played ? ' played' : ''}`}>
      {showPodcast && (podcast?.imageUrl ? <img className="cover sm" src={episode.imageUrl ?? podcast.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="cover sm" />)}
      <button className="btn icon primary" style={{ width: 38, height: 38, borderRadius: 19, flex: 'none' }} onClick={() => (current ? toggle() : void play(episode.id, { queueId }))} aria-label={`${playing ? 'Pause' : 'Play'} ${episode.title}`}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <div className="grow">
        <button className="btn ghost ep-title" style={{ padding: 0, textAlign: 'left', height: 'auto', display: 'block', whiteSpace: 'normal' }} onClick={() => onOpen(episode.id)}>
          {episode.title}
        </button>
        <div className="tiny muted row wrap" style={{ gap: 6 }}>
          {showPodcast && <span>{podcast?.title}</span>}
          <span>{timeAgo(episode.publishedAt)}</span>
          {episode.duration ? <span>· {formatDuration(episode.duration)}</span> : null}
          {episode.meta?.season != null && episode.meta.episode != null && <span>· S{episode.meta.season} E{episode.meta.episode}</span>}
          {hasTranscript && <span className="badge" title="Publisher transcript available">Transcript</span>}
          {episode.meta?.chapters && <span className="badge">Chapters</span>}
          {hasValue && <span className="badge" title="Supports Lightning value-for-value"><Icon name="zap" size={11} /> Value</span>}
        </div>
        {episode.summary && <div className="small secondary clamp-2" style={{ marginTop: 2 }}>{episode.summary}</div>}
        {pct > 0 && !episode.played && (
          <div className="progress-line" aria-label={`${Math.round(pct)}% played`}>
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="row" style={{ flex: 'none' }}>
        <QueueMenu episodeId={episode.id} label="" />
        <button
          className={`btn icon ghost${episode.played ? ' on' : ''}`}
          onClick={() => void db.episodes.update(episode.id, { played: episode.played ? 0 : 1, position: 0 })}
          aria-pressed={episode.played === 1}
          aria-label="Played"
          title={episode.played ? 'Played (click to mark as unplayed)' : 'Mark as played'}
        >
          <Icon name="check" />
        </button>
        {actions}
      </div>
    </div>
  );
}
