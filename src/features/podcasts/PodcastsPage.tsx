import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { Empty } from '../../components/Empty';
import { Icon } from '../../components/Icon';
import { ImportOpmlDialog } from '../../components/OpmlDialog';
import { Modal } from '../../components/Modal';
import { db, type Group, type Podcast } from '../../db';
import { refreshAll } from '../../lib/ingest';
import { createQueue } from '../../lib/queues';
import { useNav } from '../../state/nav';
import { errorMessage, toast } from '../../state/toasts';
import { AddFeedDialog } from '../reader/AddFeedDialog';
import { EpisodeDetail } from './EpisodeDetail';
import { EpisodeRow } from './EpisodeRow';
import { PodcastDetail } from './PodcastDetail';
import { QueueView } from './QueueView';

type View = { kind: 'latest' } | { kind: 'podcast'; id: number } | { kind: 'episode'; id: number } | { kind: 'queue'; id: number };

export function PodcastsPage() {
  const [view, setView] = useState<View>({ kind: 'latest' });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [groupDialog, setGroupDialog] = useState<Group | 'new' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mobilePane, setMobilePane] = useState<'library' | 'content'>('library');
  const [dropTarget, setDropTarget] = useState<number | 'none' | null>(null);
  const [dragging, setDragging] = useState(false);

  const podcasts = useLiveQuery(() => db.podcasts.toArray(), []) ?? [];
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), []) ?? [];
  const queues = useLiveQuery(() => db.queues.orderBy('order').toArray(), []) ?? [];
  const latest = useLiveQuery(() => db.episodes.orderBy('publishedAt').reverse().limit(60).toArray(), []) ?? [];
  const podcastsById = useMemo(() => new Map(podcasts.map((p) => [p.id, p])), [podcasts]);

  // Jump here from the player ("show this episode").
  const navPodcastId = useNav((s) => s.podcastId);
  const navEpisodeId = useNav((s) => s.episodeId);
  useEffect(() => {
    if (navEpisodeId) {
      setView({ kind: 'episode', id: navEpisodeId });
      setMobilePane('content');
    } else if (navPodcastId) {
      setView({ kind: 'podcast', id: navPodcastId });
      setMobilePane('content');
    }
  }, [navPodcastId, navEpisodeId]);

  const openView = (v: View) => {
    setView(v);
    setMobilePane('content');
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshAll('podcast');
      toast.ok(r.failed ? `Refreshed ${r.ok} podcasts, ${r.failed} failed. ${r.newItems} new episodes.` : `Refreshed. ${r.newItems} new episode${r.newItems === 1 ? '' : 's'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const addToGroup = async (podcastId: number, groupId: number) => {
    const p = await db.podcasts.get(podcastId);
    if (p && !p.groupIds.includes(groupId)) await db.podcasts.update(podcastId, { groupIds: [...p.groupIds, groupId] });
  };

  const dropProps = (groupId: number | undefined) => {
    const key = groupId ?? 'none';
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-bitpod-podcast')) {
          e.preventDefault();
          setDropTarget(key);
        }
      },
      onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const id = Number(e.dataTransfer.getData('application/x-bitpod-podcast'));
        if (!id) return;
        if (groupId !== undefined) void addToGroup(id, groupId);
        else void db.podcasts.update(id, { groupIds: [] });
      },
      style: dropTarget === key ? { outline: '2px dashed var(--accent)', outlineOffset: -2, borderRadius: 6 } : undefined,
    };
  };

  const podcastButton = (p: Podcast) => (
    <button
      key={p.id}
      className="side-item sub"
      aria-current={(view.kind === 'podcast' && view.id === p.id) || undefined}
      onClick={() => openView({ kind: 'podcast', id: p.id })}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-bitpod-podcast', String(p.id));
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      {p.imageUrl ? <img className="favicon" src={p.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="mic" size={16} />}
      <span className="grow ellipsis">{p.title}</span>
      {p.lastError && <Icon name="alert" size={14} />}
    </button>
  );

  const ungrouped = podcasts.filter((p) => !p.groupIds.some((id) => groups.some((g) => g.id === id)));

  let content: React.ReactNode;
  if (view.kind === 'podcast') {
    const p = podcastsById.get(view.id);
    content = p ? (
      <PodcastDetail key={p.id} podcast={p} groups={groups} onOpenEpisode={(id) => openView({ kind: 'episode', id })} onBack={() => setMobilePane('library')} onRemoved={() => openView({ kind: 'latest' })} />
    ) : null;
  } else if (view.kind === 'episode') {
    content = (
      <EpisodeDetail
        key={view.id}
        episodeId={view.id}
        onBack={async () => {
          const ep = await db.episodes.get(view.id);
          openView(ep ? { kind: 'podcast', id: ep.podcastId } : { kind: 'latest' });
        }}
        onOpenPodcast={(id) => openView({ kind: 'podcast', id })}
      />
    );
  } else if (view.kind === 'queue') {
    const q = queues.find((x) => x.id === view.id);
    content = q ? <QueueView key={q.id} queue={q} onOpenEpisode={(id) => openView({ kind: 'episode', id })} onBack={() => setMobilePane('library')} onDeleted={() => openView({ kind: 'latest' })} /> : null;
  } else {
    content = (
      <div>
        <div className="pane-head">
          <button className="btn icon ghost mobile-only" onClick={() => setMobilePane('library')} aria-label="Back to library">
            <Icon name="chevron-left" />
          </button>
          <strong>Latest episodes</strong>
        </div>
        {latest.map((e) => (
          <EpisodeRow key={e.id} episode={e} podcast={podcastsById.get(e.podcastId)} showPodcast onOpen={(id) => openView({ kind: 'episode', id })} />
        ))}
        {podcasts.length === 0 && (
          <Empty icon="mic" title="Add your first podcast">
            Paste a podcast RSS feed address. Standard feeds and Podcasting 2.0 features (transcripts, chapters, Lightning value) are supported.
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => setAdding(true)}>
                <Icon name="plus" /> Add podcast
              </button>
            </div>
          </Empty>
        )}
      </div>
    );
  }

  return (
    <div className="podcasts">
      <div className={`pane${mobilePane !== 'library' ? ' mobile-hide' : ''}`}>
        <div className="pane-head">
          <strong className="grow">Podcasts</strong>
          <button className="btn icon" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh all podcasts" title="Refresh all podcasts">
            <Icon name="refresh" />
          </button>
          <button className="btn icon" onClick={() => setImporting(true)} aria-label="Import OPML" title="Import OPML">
            <Icon name="upload" />
          </button>
          <button className="btn icon primary" onClick={() => setAdding(true)} aria-label="Add podcast" title="Add podcast">
            <Icon name="plus" />
          </button>
        </div>

        <button className="side-item" aria-current={view.kind === 'latest' || undefined} onClick={() => openView({ kind: 'latest' })}>
          <Icon name="list" size={16} />
          <span className="grow">Latest episodes</span>
        </button>

        <div className="side-group">
          <span className="grow">Queues</span>
          <button
            className="btn icon ghost"
            style={{ width: 22, height: 22 }}
            aria-label="New queue"
            title="New queue"
            onClick={() => {
              const name = prompt('Queue name', 'New queue');
              if (name?.trim()) void createQueue(name).then((id) => openView({ kind: 'queue', id }));
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {queues.map((q) => (
          <button key={q.id} className="side-item" aria-current={(view.kind === 'queue' && view.id === q.id) || undefined} onClick={() => openView({ kind: 'queue', id: q.id })}>
            <Icon name="headphones" size={16} />
            <span className="grow ellipsis">{q.name}</span>
            {q.episodeIds.length > 0 && <span className="badge count">{q.episodeIds.length}</span>}
          </button>
        ))}
        {queues.length === 0 && <div className="tiny muted" style={{ padding: '0 12px 6px' }}>Queue an episode to create “Up next”.</div>}

        <div className="side-group">
          <span className="grow">Groups</span>
          <button className="btn icon ghost" style={{ width: 22, height: 22 }} onClick={() => setGroupDialog('new')} aria-label="New group" title="New group">
            <Icon name="plus" size={14} />
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.id} {...dropProps(g.id)}>
            <div className="row">
              <div className="side-item grow" style={{ cursor: 'default' }}>
                <Icon name="folder" size={16} />
                <span className="grow ellipsis">{g.name}</span>
              </div>
              <button className="btn icon ghost" style={{ width: 26, height: 26, marginRight: 4 }} onClick={() => setGroupDialog(g)} aria-label={`Edit group ${g.name}`}>
                <Icon name="edit" size={13} />
              </button>
            </div>
            {podcasts.filter((p) => p.groupIds.includes(g.id)).map(podcastButton)}
            {!podcasts.some((p) => p.groupIds.includes(g.id)) && <div className="tiny muted" style={{ padding: '0 12px 6px 30px' }}>Drag podcasts here</div>}
          </div>
        ))}
        <div {...dropProps(undefined)}>
          {/* Also the drop target for removing a podcast from all groups, so it shows while dragging. */}
          {groups.length > 0 && (ungrouped.length > 0 || dragging) && <div className="side-group">Ungrouped</div>}
          {ungrouped.map(podcastButton)}
        </div>
        {podcasts.length === 0 && <div className="tiny muted" style={{ padding: '8px 12px' }}>No podcasts yet.</div>}
      </div>

      <div className={`pane${mobilePane !== 'content' ? ' mobile-hide' : ''}`}>{content}</div>

      {adding && <AddFeedDialog target="podcast" onClose={() => setAdding(false)} onAdded={(r) => r.kind === 'podcast' && openView({ kind: 'podcast', id: r.id })} />}
      {importing && <ImportOpmlDialog onClose={() => setImporting(false)} />}
      {groupDialog && <GroupDialog group={groupDialog === 'new' ? null : groupDialog} onClose={() => setGroupDialog(null)} />}
    </div>
  );
}

function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (group) await db.groups.update(group.id, { name: trimmed });
    else await db.groups.add({ name: trimmed, order: await db.groups.count() });
    onClose();
  };
  const remove = async () => {
    if (!group || !confirm(`Delete the group "${group.name}"? Podcasts in it are kept.`)) return;
    await db.transaction('rw', db.groups, db.podcasts, async () => {
      await db.podcasts.where('groupIds').equals(group.id).modify((p) => {
        p.groupIds = p.groupIds.filter((id) => id !== group.id);
      });
      await db.groups.delete(group.id);
    });
    onClose();
  };
  return (
    <Modal
      title={group ? 'Edit group' : 'New group'}
      onClose={onClose}
      actions={
        <>
          {group && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}>
              Delete
            </button>
          )}
          <button className="btn" data-close onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bitcoin, News, Commute" maxLength={60} />
        </label>
      </form>
    </Modal>
  );
}
