import { useRef, useState } from 'react';
import { parseOpml, type OpmlFeed } from '../../shared/opml';
import { Modal } from './Modal';
import { exportOpml, importOpml, type OpmlImportResult } from '../lib/ingest';
import { errorMessage, toast } from '../state/toasts';

/** Import subscriptions from an OPML file. Feeds are sorted into the right section automatically. */
export function ImportOpmlDialog({ onClose }: { onClose: () => void }) {
  const [feeds, setFeeds] = useState<OpmlFeed[] | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<OpmlImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseOpml(await file.text());
      if (!parsed.length) throw new Error('No feeds were found in that file.');
      setFeeds(parsed);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const run = async () => {
    if (!feeds) return;
    setProgress([0, feeds.length]);
    const r = await importOpml(feeds, (done, total) => setProgress([done, total]));
    setResult(r);
    setProgress(null);
    toast.ok(`Imported ${r.added} feed${r.added === 1 ? '' : 's'}${r.failed.length ? `, ${r.failed.length} failed` : ''}.`);
  };

  const categories = feeds ? [...new Set(feeds.map((f) => f.category).filter(Boolean))] : [];

  return (
    <Modal
      title="Import OPML"
      onClose={onClose}
      actions={
        <>
          <button className="btn" data-close onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button className="btn primary" disabled={!feeds || !!progress} onClick={() => void run()}>
              {progress ? `Importing ${progress[0]}/${progress[1]}…` : `Import ${feeds?.length ?? ''} feeds`}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <p className="secondary small" style={{ margin: 0 }}>
          Choose an OPML file exported from another reader or podcast app. Podcasts and article feeds are sorted automatically; folders become categories (articles) or groups (podcasts).
        </p>
        <input ref={fileRef} type="file" accept=".opml,.xml,text/xml,application/xml" onChange={(e) => void onFile(e.target.files?.[0])} />
        {feeds && !result && (
          <div className="notice">
            Found <strong>{feeds.length}</strong> feeds{categories.length ? <> in <strong>{categories.length}</strong> folders</> : null}. Importing fetches each feed, so it can take a little while.
          </div>
        )}
        {result && (
          <div className="stack">
            <div className="notice">
              Added {result.added}, already subscribed {result.existed}, failed {result.failed.length}.
            </div>
            {result.failed.length > 0 && (
              <ul className="small" style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
                {result.failed.map((f) => (
                  <li key={f.url}>
                    <span className="mono">{f.url}</span>: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export async function downloadOpml(): Promise<void> {
  const xml = await exportOpml();
  const url = URL.createObjectURL(new Blob([xml], { type: 'text/x-opml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bitpodrss-subscriptions.opml';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
