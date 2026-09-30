import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { db, type Category, type Feed } from '../../db';
import { errorMessage, toast } from '../../state/toasts';
import { displayHost } from '../../../shared/url';

export type Selection =
  | { kind: 'all' }
  | { kind: 'starred' }
  | { kind: 'dups' }
  | { kind: 'category'; id: number }
  | { kind: 'feed'; id: number };

export function useUnreadCounts(): Map<number, number> {
  return (
    useLiveQuery(async () => {
      const counts = new Map<number, number>();
      await db.articles.where('read').equals(0).each((a) => counts.set(a.feedId, (counts.get(a.feedId) ?? 0) + 1));
      return counts;
    }, []) ?? new Map()
  );
}

interface Props {
  selection: Selection;
  onSelect: (s: Selection) => void;
  feeds: Feed[];
  categories: Category[];
  unread: Map<number, number>;
  dupCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  onAdd: () => void;
  onImport: () => void;
  onEditFeed: (feed: Feed) => void;
}

export function FeedSidebar({ selection, onSelect, feeds, categories, unread, dupCount, refreshing, onRefresh, onAdd, onImport, onEditFeed }: Props) {
  const [dropTarget, setDropTarget] = useState<number | 'none' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [categoryDialog, setCategoryDialog] = useState<Category | 'new' | null>(null);
  const totalUnread = [...unread.values()].reduce((a, b) => a + b, 0);

  const countFor = (feedIds: number[]) => feedIds.reduce((sum, id) => sum + (unread.get(id) ?? 0), 0);
  const uncategorized = feeds.filter((f) => !categories.some((c) => c.id === f.categoryId));

  const moveFeed = async (feedId: number, categoryId: number | undefined) => {
    await db.feeds.update(feedId, { categoryId });
  };

  const dropProps = (categoryId: number | undefined) => {
    const key = categoryId ?? 'none';
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-bitpod-feed')) {
          e.preventDefault();
          setDropTarget(key);
        }
      },
      onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const id = Number(e.dataTransfer.getData('application/x-bitpod-feed'));
        if (id) void moveFeed(id, categoryId);
      },
      style: dropTarget === key ? { outline: '2px dashed var(--accent)', outlineOffset: -2, borderRadius: 6 } : undefined,
    };
  };

  const feedRow = (f: Feed, sub: boolean) => (
    <div key={f.id} className="row" style={{ position: 'relative' }}>
      <button
        className={`side-item has-edit${sub ? ' sub' : ''}`}
        aria-current={selection.kind === 'feed' && selection.id === f.id}
        onClick={() => onSelect({ kind: 'feed', id: f.id })}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-bitpod-feed', String(f.id));
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        title={f.lastError ? `Last refresh failed: ${f.lastError}` : f.title}
      >
        {f.imageUrl ? <img className="favicon" src={f.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="rss" size={16} />}
        <span className="grow ellipsis">{f.title}</span>
        {f.lastError && <Icon name="alert" size={14} />}
        {(unread.get(f.id) ?? 0) > 0 && <span className="badge count">{unread.get(f.id)}</span>}
      </button>
      <button className="btn icon ghost" style={{ position: 'absolute', right: 2, width: 26, height: 26, opacity: 0.6 }} onClick={() => onEditFeed(f)} aria-label={`Manage ${f.title}`}>
        <Icon name="edit" size={13} />
      </button>
    </div>
  );

  return (
    <nav aria-label="Feeds">
      <div className="pane-head">
        <strong className="grow">Reader</strong>
        <button className="btn icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh all feeds" title="Refresh all feeds">
          <Icon name="refresh" />
        </button>
        <button className="btn icon" onClick={onImport} aria-label="Import OPML" title="Import OPML">
          <Icon name="upload" />
        </button>
        <button className="btn icon primary" onClick={onAdd} aria-label="Add feed" title="Add feed">
          <Icon name="plus" />
        </button>
      </div>

      <button className="side-item" aria-current={selection.kind === 'all'} onClick={() => onSelect({ kind: 'all' })}>
        <Icon name="list" size={16} />
        <span className="grow">All articles</span>
        {totalUnread > 0 && <span className="badge count">{totalUnread}</span>}
      </button>
      <button className="side-item" aria-current={selection.kind === 'starred'} onClick={() => onSelect({ kind: 'starred' })}>
        <Icon name="star" size={16} />
        <span className="grow">Starred</span>
      </button>
      <button className="side-item" aria-current={selection.kind === 'dups'} onClick={() => onSelect({ kind: 'dups' })}>
        <Icon name="merge" size={16} />
        <span className="grow">Possible duplicates</span>
        {dupCount > 0 && <span className="badge dup">{dupCount}</span>}
      </button>

      <div className="side-group">
        <span className="grow">Categories</span>
        <button className="btn icon ghost" style={{ width: 22, height: 22 }} onClick={() => setCategoryDialog('new')} aria-label="New category" title="New category">
          <Icon name="plus" size={14} />
        </button>
      </div>

      {categories.map((c) => {
        const inCat = feeds.filter((f) => f.categoryId === c.id);
        return (
          <div key={c.id} {...dropProps(c.id)}>
            <div className="row">
              <button className="side-item grow" aria-current={selection.kind === 'category' && selection.id === c.id} onClick={() => onSelect({ kind: 'category', id: c.id })}>
                <Icon name="folder" size={16} />
                <span className="grow ellipsis">{c.name}</span>
                {countFor(inCat.map((f) => f.id)) > 0 && <span className="badge count">{countFor(inCat.map((f) => f.id))}</span>}
              </button>
              <button className="btn icon ghost" style={{ width: 26, height: 26, marginRight: 4 }} onClick={() => setCategoryDialog(c)} aria-label={`Edit category ${c.name}`}>
                <Icon name="edit" size={13} />
              </button>
            </div>
            {inCat.map((f) => feedRow(f, true))}
            {inCat.length === 0 && <div className="tiny muted" style={{ padding: '0 12px 6px 30px' }}>Drag feeds here</div>}
          </div>
        );
      })}

      <div {...dropProps(undefined)}>
        {/* Also the drop target for removing a feed from its category, so it shows while dragging. */}
        {categories.length > 0 && (uncategorized.length > 0 || dragging) && <div className="side-group">Uncategorized</div>}
        {uncategorized.map((f) => feedRow(f, false))}
      </div>

      {feeds.length === 0 && (
        <div className="empty small">
          No feeds yet. Add one with <Icon name="plus" size={14} /> or import an OPML file.
        </div>
      )}

      {categoryDialog && <CategoryDialog category={categoryDialog === 'new' ? null : categoryDialog} onClose={() => setCategoryDialog(null)} />}
    </nav>
  );
}

function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      if (category) await db.categories.update(category.id, { name: trimmed });
      else await db.categories.add({ name: trimmed, order: await db.categories.count() });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async () => {
    if (!category || !confirm(`Delete the category "${category.name}"? Its feeds are kept and become uncategorized.`)) return;
    await db.transaction('rw', db.categories, db.feeds, async () => {
      await db.feeds.where('categoryId').equals(category.id).modify({ categoryId: undefined });
      await db.categories.delete(category.id);
    });
    onClose();
  };
  return (
    <Modal
      title={category ? 'Edit category' : 'New category'}
      onClose={onClose}
      actions={
        <>
          {category && (
            <button className="btn danger" onClick={() => void remove()} style={{ marginRight: 'auto' }}>
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
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tech, News, Bitcoin" maxLength={60} />
        </label>
      </form>
    </Modal>
  );
}

export function ManageFeedDialog({ feed, categories, onClose }: { feed: Feed; categories: Category[]; onClose: () => void }) {
  const [title, setTitle] = useState(feed.title);
  const [categoryId, setCategoryId] = useState<number | ''>(feed.categoryId ?? '');
  const save = async () => {
    await db.feeds.update(feed.id, { title: title.trim() || feed.title, categoryId: categoryId === '' ? undefined : categoryId });
    onClose();
  };
  const remove = async () => {
    if (!confirm(`Unsubscribe from "${feed.title}" and delete its articles?`)) return;
    await db.transaction('rw', db.feeds, db.articles, async () => {
      await db.articles.where('feedId').equals(feed.id).delete();
      await db.feeds.delete(feed.id);
    });
    onClose();
  };
  return (
    <Modal
      title="Manage feed"
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
        <label className="field">
          Name
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          Category
          <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value === '' ? '' : Number(e.target.value))}>
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="small muted">
          <div className="mono ellipsis" title={feed.url}>
            {feed.url}
          </div>
          {feed.link && (
            <a href={feed.link} target="_blank" rel="noopener noreferrer">
              {displayHost(feed.link)}
            </a>
          )}
          {feed.lastError && <div className="notice error" style={{ marginTop: 8 }}>Last refresh failed: {feed.lastError}</div>}
        </div>
      </div>
    </Modal>
  );
}
