import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { db } from '../../db';
import { addToQueue, createQueue, getDefaultQueue, removeFromQueue } from '../../lib/queues';
import { toast } from '../../state/toasts';

/** "Add to queue" menu for an episode: toggles membership in any queue, or starts a new one. */
export function QueueMenu({ episodeId, label }: { episodeId: number; label?: string }) {
  const queues = useLiveQuery(() => db.queues.orderBy('order').toArray(), []) ?? [];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const inAny = queues.some((q) => q.episodeIds.includes(episodeId));

  const quickAdd = async () => {
    const q = await getDefaultQueue();
    if (q.episodeIds.includes(episodeId)) await removeFromQueue(q.id, episodeId);
    else {
      await addToQueue(q.id, episodeId);
      toast.info(`Added to ${q.name}.`);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="btn" onClick={() => (queues.length > 1 ? setOpen(!open) : void quickAdd())} aria-haspopup={queues.length > 1 ? 'menu' : undefined} aria-expanded={queues.length > 1 ? open : undefined} title="Add to queue">
        <Icon name={inAny ? 'check' : 'list'} size={16} /> {label ?? 'Queue'}
        {queues.length > 1 && <Icon name="chevron-down" size={14} />}
      </button>
      {open && (
        <div role="menu" className="card stack" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 10, minWidth: 220, gap: 4, padding: 8, marginTop: 4, boxShadow: 'var(--shadow)' }}>
          {queues.map((q) => {
            const inQ = q.episodeIds.includes(episodeId);
            return (
              <button
                key={q.id}
                role="menuitemcheckbox"
                aria-checked={inQ}
                className="btn ghost"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => void (inQ ? removeFromQueue(q.id, episodeId) : addToQueue(q.id, episodeId))}
              >
                <span style={{ width: 18 }}>{inQ && <Icon name="check" size={14} />}</span>
                {q.name}
              </button>
            );
          })}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void createQueue(name).then((id) => addToQueue(id, episodeId));
              setName('');
              setOpen(false);
            }}
          >
            <input className="input" placeholder="New queue…" value={name} onChange={(e) => setName(e.target.value)} aria-label="New queue name" maxLength={40} />
            <button className="btn icon" type="submit" aria-label="Create queue" disabled={!name.trim()}>
              <Icon name="plus" size={15} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
