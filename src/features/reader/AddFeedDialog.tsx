import { useState } from 'react';
import { Modal } from '../../components/Modal';
import type { Category } from '../../db';
import { addFeed } from '../../lib/ingest';
import { errorMessage, toast } from '../../state/toasts';
import type { FeedKind } from '../../../shared/types';

interface Props {
  target: FeedKind;
  categories?: Category[];
  defaultCategoryId?: number;
  onClose: () => void;
  onAdded?: (result: { kind: FeedKind; id: number }) => void;
}

/** Add an RSS/Atom/JSON feed (Reader) or a podcast feed (Podcasts) by URL. A website address also works. */
export function AddFeedDialog({ target, categories = [], defaultCategoryId, onClose, onAdded }: Props) {
  const [url, setUrl] = useState('');
  const [categoryId, setCategoryId] = useState<number | ''>(defaultCategoryId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPodcast = target === 'podcast';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await addFeed(url, { target, categoryId: categoryId === '' ? undefined : categoryId });
      if (r.existed) toast.info(`You are already subscribed to ${r.title}.`);
      else if (r.routed) toast.ok(`${r.title} is a podcast, so it was added to Podcasts (${r.added} episodes).`);
      else toast.ok(`Added ${r.title} (${r.added} ${isPodcast ? 'episodes' : 'articles'}).`);
      onAdded?.({ kind: r.kind, id: r.id });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isPodcast ? 'Add podcast' : 'Add feed'}
      onClose={onClose}
      actions={
        <>
          <button className="btn" data-close onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !url.trim()} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && !busy) void submit();
        }}
      >
        <label className="field">
          {isPodcast ? 'Podcast RSS feed URL' : 'Feed or website address'}
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={isPodcast ? 'https://example.com/podcast.xml' : 'https://example.com/feed.xml or example.com'} inputMode="url" autoComplete="off" spellCheck={false} />
        </label>
        {!isPodcast && categories.length > 0 && (
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
        )}
        <p className="small muted" style={{ margin: 0 }}>
          {isPodcast
            ? 'Supports standard podcast feeds (RSS with iTunes tags) and Podcasting 2.0 features: transcripts, chapters, persons and Lightning value blocks.'
            : 'Supports RSS, Atom and JSON Feed. If you paste a website address, its feed is found automatically.'}
        </p>
        {error && <div className="notice error">{error}</div>}
      </form>
    </Modal>
  );
}
