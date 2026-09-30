import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Empty } from '../../components/Empty';
import { Icon } from '../../components/Icon';
import { ImportOpmlDialog } from '../../components/OpmlDialog';
import { db, type Article, type Feed } from '../../db';
import { refreshAll } from '../../lib/ingest';
import { useSettings } from '../../state/settings';
import { errorMessage, toast } from '../../state/toasts';
import { AddFeedDialog } from './AddFeedDialog';
import { ArticleList } from './ArticleList';
import { ArticleView } from './ArticleView';
import { FeedSidebar, ManageFeedDialog, useUnreadCounts, type Selection } from './FeedSidebar';
import { useDuplicates } from './useDuplicates';

type MobilePane = 'feeds' | 'list' | 'article';

const MAX_LIST = 600;

export function ReaderPage() {
  const [selection, setSelection] = useState<Selection>({ kind: 'all' });
  const [articleId, setArticleId] = useState<number | undefined>();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Feed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('feeds');
  const hideDuplicates = useSettings((s) => s.hideDuplicates);
  const setSettings = useSettings((s) => s.set);

  const feeds = useLiveQuery(() => db.feeds.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.orderBy('order').toArray(), []) ?? [];
  const unread = useUnreadCounts();
  const dups = useDuplicates();
  const feedsById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);

  const selectionFeedIds = useMemo(() => {
    if (selection.kind === 'feed') return [selection.id];
    if (selection.kind === 'category') return feeds.filter((f) => f.categoryId === selection.id).map((f) => f.id);
    return null;
  }, [selection, feeds]);

  const rows = useLiveQuery(async (): Promise<Article[]> => {
    const byDateDesc = (a: Article, b: Article) => b.publishedAt - a.publishedAt;
    if (selectionFeedIds) {
      if (!selectionFeedIds.length) return [];
      return (await db.articles.where('feedId').anyOf(selectionFeedIds).toArray()).sort(byDateDesc).slice(0, MAX_LIST);
    }
    if (selection.kind === 'starred') return (await db.articles.where('starred').equals(1).toArray()).sort(byDateDesc);
    return db.articles.orderBy('publishedAt').reverse().limit(selection.kind === 'dups' ? 3000 : MAX_LIST).toArray();
  }, [selection.kind, selectionFeedIds?.join(',')]);

  const visible = useMemo(() => {
    let list = rows ?? [];
    if (selection.kind === 'dups') {
      list = list.filter((a) => dups.info.has(a.id)).sort((a, b) => dups.info.get(a.id)!.clusterId - dups.info.get(b.id)!.clusterId || a.publishedAt - b.publishedAt);
    } else if (hideDuplicates) {
      list = list.filter((a) => !dups.info.has(a.id) || dups.info.get(a.id)!.primaryId === a.id);
    }
    if (unreadOnly) list = list.filter((a) => a.read === 0 || a.id === articleId);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((a) => a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q));
    return list;
  }, [rows, selection.kind, dups.info, hideDuplicates, unreadOnly, search, articleId]);

  const title = useMemo(() => {
    switch (selection.kind) {
      case 'all':
        return 'All articles';
      case 'starred':
        return 'Starred';
      case 'dups':
        return 'Possible duplicates';
      case 'category':
        return categories.find((c) => c.id === selection.id)?.name ?? 'Category';
      case 'feed':
        return feedsById.get(selection.id)?.title ?? 'Feed';
    }
  }, [selection, categories, feedsById]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshAll('article');
      toast.ok(r.failed ? `Refreshed ${r.ok} feeds, ${r.failed} failed. ${r.newItems} new articles.` : `Refreshed. ${r.newItems} new article${r.newItems === 1 ? '' : 's'}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const select = (s: Selection) => {
    setSelection(s);
    setMobilePane('list');
  };

  const open = (id: number) => {
    setArticleId(id);
    setMobilePane('article');
  };

  const markAllRead = async () => {
    const ids = visible.filter((a) => a.read === 0).map((a) => a.id);
    if (!ids.length) return;
    await db.articles.where('id').anyOf(ids).modify({ read: 1 });
    toast.info(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'} as read.`);
  };

  const dupCount = useMemo(() => new Set([...dups.info.values()].map((i) => i.clusterId)).size, [dups.info]);

  return (
    <div className="reader">
      <div className={`pane${mobilePane !== 'feeds' ? ' mobile-hide' : ''}`}>
        <FeedSidebar
          selection={selection}
          onSelect={select}
          feeds={feeds}
          categories={categories}
          unread={unread}
          dupCount={dupCount}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onAdd={() => setAdding(true)}
          onImport={() => setImporting(true)}
          onEditFeed={setEditing}
        />
      </div>

      <div className={`pane${mobilePane !== 'list' ? ' mobile-hide' : ''}`}>
        <div className="pane-head" style={{ flexWrap: 'wrap' }}>
          <button className="btn icon ghost mobile-only" onClick={() => setMobilePane('feeds')} aria-label="Back to feeds">
            <Icon name="chevron-left" />
          </button>
          <strong className="grow ellipsis">{title}</strong>
          <button className="btn icon ghost" onClick={() => void markAllRead()} title="Mark all as read" aria-label="Mark all as read">
            <Icon name="check" />
          </button>
          <div className="row" style={{ width: '100%' }}>
            <div className="grow" style={{ position: 'relative' }}>
              <input className="input" style={{ paddingLeft: 30 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles" aria-label="Search articles" />
              <span style={{ position: 'absolute', left: 9, top: 9, color: 'var(--muted)' }}>
                <Icon name="search" size={15} />
              </span>
            </div>
          </div>
          <div className="row wrap small" style={{ width: '100%' }}>
            <label className="switch">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
            </label>
            <label className="switch" title="Show only the earliest copy of stories that several feeds published">
              <input type="checkbox" checked={hideDuplicates} onChange={(e) => setSettings({ hideDuplicates: e.target.checked })} /> Hide duplicates
            </label>
          </div>
        </div>
        {visible.length === 0 ? (
          feeds.length === 0 ? (
            <Empty icon="rss" title="Welcome to BitPodRSS">
              Add your first feed to get started.
              <div style={{ marginTop: 12 }}>
                <button className="btn primary" onClick={() => setAdding(true)}>
                  <Icon name="plus" /> Add feed
                </button>
              </div>
            </Empty>
          ) : (
            <Empty icon="check" title={selection.kind === 'dups' ? 'No duplicates found' : 'Nothing to show'}>
              {selection.kind === 'dups' ? 'Stories that appear in more than one feed are highlighted here.' : unreadOnly ? 'You are all caught up.' : 'Try refreshing your feeds.'}
            </Empty>
          )
        ) : (
          <ArticleList articles={visible} feeds={feedsById} dupInfo={dups.info} selectedId={articleId} onSelect={(a) => open(a.id)} />
        )}
      </div>

      <div className={`pane${mobilePane !== 'article' ? ' mobile-hide' : ''}`}>
        {articleId ? (
          <ArticleView articleId={articleId} feeds={feedsById} dup={dups.info.get(articleId)} dupArticles={dups.articles} onOpen={open} onBack={() => setMobilePane('list')} />
        ) : (
          <Empty icon="file" title="Select an article">
            Titles, summaries and duplicate warnings show up here. Press <span className="kbd">Listen</span> to hear an article read aloud.
          </Empty>
        )}
      </div>

      {adding && <AddFeedDialog target="article" categories={categories} defaultCategoryId={selection.kind === 'category' ? selection.id : undefined} onClose={() => setAdding(false)} onAdded={(r) => r.kind === 'article' && setSelection({ kind: 'feed', id: r.id })} />}
      {importing && <ImportOpmlDialog onClose={() => setImporting(false)} />}
      {editing && <ManageFeedDialog feed={editing} categories={categories} onClose={() => setEditing(null)} />}
    </div>
  );
}

