import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { displayHost } from '../../../shared/url';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { db, type Group, type Podcast } from '../../db';
import { refreshPodcast } from '../../lib/ingest';
import { pruneQueues } from '../../lib/queues';
import { formatSats } from '../../lib/format';
import { errorMessage, toast } from '../../state/toasts';
import { EpisodeRow } from './EpisodeRow';

export function PodcastDetail({ podcast, groups, onOpenEpisode, onBack, onRemoved }: { podcast: Podcast; groups: Group[]; onOpenEpisode: (id: number) => void; onBack: () => void; onRemoved: () => void }) {
  const episodes = useLiveQuery(() => db.episodes.where('podcastId').equals(podcast.id).toArray(), [podcast.id]) ?? [];
  const [oldestFirst, setOldestFirst] = useState(podcast.meta?.showType === 'serial');
  const [unplayedOnly, setUnplayedOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [managing, setManaging] = useState(false);

  const list = useMemo(() => {
    const sorted = [...episodes].sort((a, b) => (oldestFirst ? a.publishedAt - b.publishedAt : b.publishedAt - a.publishedAt));
    return unplayedOnly ? sorted.filter((e) => !e.played) : sorted;
  }, [episodes, oldestFirst, unplayedOnly]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const n = await refreshPodcast(podcast.id);
      toast.ok(n ? `${n} new episode${n === 1 ? '' : 's'}.` : 'Up to date.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const value = podcast.meta?.value;
  const podcastGroups = groups.filter((g) => podcast.groupIds.includes(g.id));

  return (
    <div>
      <div className="container" style={{ paddingBottom: 8 }}>
        <button className="btn ghost mobile-only" onClick={onBack} style={{ marginBottom: 8 }}>
          <Icon name="chevron-left" /> Back
        </button>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          {podcast.imageUrl ? <img className="cover lg" src={podcast.imageUrl} alt="" referrerPolicy="no-referrer" /> : <div className="cover lg" />}
          <div className="grow stack" style={{ gap: 6 }}>
            <h1 style={{ fontSize: 26 }}>{podcast.title}</h1>
            {podcast.author && <div className="secondary">{podcast.author}</div>}
            <p className="small secondary clamp-2" style={{ margin: 0 }}>{podcast.description}</p>
            <div className="row wrap small" style={{ gap: 6 }}>
              {podcastGroups.map((g) => (
                <span key={g.id} className="badge">
                  <Icon name="folder" size={12} /> {g.name}
                </span>
              ))}
              {podcast.meta?.medium && podcast.meta.medium !== 'podcast' && <span className="badge">{podcast.meta.medium}</span>}
              {value && (
                <span className="badge" title={value.recipients.map((r) => `${r.name ?? r.address}: ${r.split}`).join('\n')}>
                  <Icon name="zap" size={12} /> Value-for-value{value.suggestedSatsPerMinute ? ` · suggests ${formatSats(value.suggestedSatsPerMinute)}/min` : ''}
                </span>
              )}
              {podcast.lastError && <span className="badge" style={{ color: 'var(--bad)' }}>Refresh failed: {podcast.lastError}</span>}
            </div>
            <div className="row wrap" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => void refresh()} disabled={refreshing}>
                <Icon name="refresh" size={16} /> {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              <button className="btn" onClick={() => setManaging(true)}>
                <Icon name="folder" size={16} /> Groups & settings
              </button>
              {podcast.link && (
                <a className="btn" href={podcast.link} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={16} /> {displayHost(podcast.link)}
                </a>
              )}
              {(podcast.meta?.funding ?? []).map((f, i) => (
                <a key={i} className="btn" href={f.url} target="_blank" rel="noopener noreferrer">
                  {f.text || 'Support'}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="row small" style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
        <strong className="grow">{episodes.length} episodes</strong>
        <label className="switch">
          <input type="checkbox" checked={unplayedOnly} onChange={(e) => setUnplayedOnly(e.target.checked)} /> Unplayed
        </label>
        <label className="switch">
          <input type="checkbox" checked={oldestFirst} onChange={(e) => setOldestFirst(e.target.checked)} /> Oldest first
        </label>
      </div>
      {list.map((e) => (
        <EpisodeRow key={e.id} episode={e} podcast={podcast} onOpen={onOpenEpisode} />
      ))}
      {list.length === 0 && <div className="empty small">{episodes.length ? 'You have played everything.' : 'No episodes yet. Try refreshing.'}</div>}

      {managing && (
        <ManageDialog
          podcast={podcast}
          groups={groups}
          onClose={() => setManaging(false)}
          onRemoved={() => {
            setManaging(false);
            onRemoved();
          }}
        />
      )}
    </div>
  );
}

function ManageDialog({ podcast, groups, onClose, onRemoved }: { podcast: Podcast; groups: Group[]; onClose: () => void; onRemoved: () => void }) {
  const [selected, setSelected] = useState<number[]>(podcast.groupIds);
  const [newGroup, setNewGroup] = useState('');

  const save = async () => {
    const ids = [...selected];
    const name = newGroup.trim();
    if (name) ids.push(await db.groups.add({ name, order: groups.length }));
    await db.podcasts.update(podcast.id, { groupIds: ids });
    onClose();
  };

  const remove = async () => {
    if (!confirm(`Unsubscribe from "${podcast.title}"? Its episodes, playback progress and transcripts are deleted from this device.`)) return;
    const ids = (await db.episodes.where('podcastId').equals(podcast.id).primaryKeys()) as number[];
    await db.transaction('rw', db.podcasts, db.episodes, db.transcripts, async () => {
      await db.transcripts.where('episodeId').anyOf(ids).delete();
      await db.episodes.where('podcastId').equals(podcast.id).delete();
      await db.podcasts.delete(podcast.id);
    });
    await pruneQueues();
    onRemoved();
  };

  return (
    <Modal
      title="Groups & settings"
      onClose={onClose}
      actions={
        <>
          <button className="btn danger" onClick={() => void remove()} style={{ marginRight: 'auto' }}>
            <Icon name="trash" size={15} /> Unsubscribe
          </button>
          <button className="btn" data-close onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div>
          <div className="small secondary" style={{ marginBottom: 6 }}>
            Groups (a podcast can be in several)
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {groups.map((g) => (
              <label key={g.id} className="switch">
                <input type="checkbox" checked={selected.includes(g.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, g.id] : s.filter((x) => x !== g.id)))} /> {g.name}
              </label>
            ))}
            {groups.length === 0 && <span className="small muted">No groups yet. Create one below.</span>}
          </div>
        </div>
        <label className="field">
          New group
          <input className="input" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Bitcoin, News, Commute" maxLength={60} />
        </label>
        <div className="small muted mono ellipsis" title={podcast.url}>
          {podcast.url}
        </div>
      </div>
    </Modal>
  );
}
