import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Empty } from '../../components/Empty';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { db, type Queue } from '../../db';
import { deleteQueue, moveInQueue, removeFromQueue } from '../../lib/queues';
import { formatDuration } from '../../lib/format';
import { usePlayer } from '../../state/player';
import { EpisodeRow } from './EpisodeRow';

export function QueueView({ queue, onOpenEpisode, onBack, onDeleted }: { queue: Queue; onOpenEpisode: (id: number) => void; onBack: () => void; onDeleted: () => void }) {
  const play = usePlayer((s) => s.play);
  const [editing, setEditing] = useState(false);
  const items = useLiveQuery(async () => {
    const eps = await db.episodes.bulkGet(queue.episodeIds);
    const podcasts = await db.podcasts.bulkGet([...new Set(eps.filter(Boolean).map((e) => e!.podcastId))]);
    const byId = new Map(podcasts.filter(Boolean).map((p) => [p!.id, p!]));
    return eps.map((e, index) => (e ? { e, index, podcast: byId.get(e.podcastId) } : undefined)).filter((x): x is NonNullable<typeof x> => !!x);
  }, [queue.episodeIds.join(',')]) ?? [];

  const total = items.reduce((sum, { e }) => sum + (e.duration ?? 0), 0);

  return (
    <div>
      <div className="container" style={{ paddingBottom: 8 }}>
        <button className="btn ghost mobile-only" onClick={onBack} style={{ marginBottom: 8 }}>
          <Icon name="chevron-left" /> Back
        </button>
        <div className="row">
          <h1 className="grow" style={{ fontSize: 24 }}>
            {queue.name}
          </h1>
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} /> Rename / delete
          </button>
        </div>
        <div className="small muted" style={{ margin: '4px 0 12px' }}>
          {items.length} episode{items.length === 1 ? '' : 's'}
          {total ? ` · ${formatDuration(total)}` : ''}. Episodes leave the queue as they finish; the next one starts automatically.
        </div>
        <button className="btn primary big" disabled={!items.length} onClick={() => void play(items[0]!.e.id, { queueId: queue.id })}>
          <Icon name="play" /> Play queue
        </button>
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {items.map(({ e, index, podcast }) => (
          <EpisodeRow
            key={e.id}
            episode={e}
            podcast={podcast}
            showPodcast
            queueId={queue.id}
            onOpen={onOpenEpisode}
            actions={
              <>
                <button className="btn icon ghost" onClick={() => void moveInQueue(queue.id, index, -1)} disabled={index === 0} aria-label="Move up">
                  <Icon name="arrow-up" size={15} />
                </button>
                <button className="btn icon ghost" onClick={() => void moveInQueue(queue.id, index, 1)} disabled={index === items.length - 1} aria-label="Move down">
                  <Icon name="arrow-down" size={15} />
                </button>
                <button className="btn icon ghost" onClick={() => void removeFromQueue(queue.id, e.id)} aria-label="Remove from queue">
                  <Icon name="x" size={15} />
                </button>
              </>
            }
          />
        ))}
        {items.length === 0 && (
          <Empty icon="list" title="This queue is empty">
            Use the Queue button on any episode to add it here.
          </Empty>
        )}
      </div>
      {editing && <QueueDialog queue={queue} onClose={() => setEditing(false)} onDeleted={onDeleted} />}
    </div>
  );
}

function QueueDialog({ queue, onClose, onDeleted }: { queue: Queue; onClose: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(queue.name);
  return (
    <Modal
      title="Queue"
      onClose={onClose}
      actions={
        <>
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={() => {
              if (!confirm(`Delete the queue "${queue.name}"? The episodes themselves are kept.`)) return;
              void deleteQueue(queue.id).then(() => {
                onClose();
                onDeleted();
              });
            }}
          >
            Delete
          </button>
          <button className="btn" data-close onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => void db.queues.update(queue.id, { name: name.trim() }).then(onClose)}
          >
            Save
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
    </Modal>
  );
}
