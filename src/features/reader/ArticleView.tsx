import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import type { DedupeItem, DuplicateInfo } from '../../../shared/dedupe';
import { summarize } from '../../../shared/summarize';
import { displayHost } from '../../../shared/url';
import { api } from '../../api';
import { Icon } from '../../components/Icon';
import { db, type Feed } from '../../db';
import { timeAgo } from '../../lib/format';
import { sanitizeHtml } from '../../lib/sanitize';
import { errorMessage, toast } from '../../state/toasts';
import { useTts } from '../../state/tts';
import { markNotDuplicate } from './useDuplicates';

interface Props {
  articleId: number;
  feeds: Map<number, Feed>;
  dup?: DuplicateInfo;
  dupArticles: Map<number, DedupeItem>;
  onOpen: (articleId: number) => void;
  onBack: () => void;
}

export function ArticleView({ articleId, feeds, dup, dupArticles, onOpen, onBack }: Props) {
  const article = useLiveQuery(() => db.articles.get(articleId), [articleId]);
  const [showFull, setShowFull] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const tts = useTts();

  useEffect(() => {
    setShowFull(false);
  }, [articleId]);

  // Opening an article marks it read.
  useEffect(() => {
    if (article && article.read === 0) void db.articles.update(article.id, { read: 1 });
  }, [article]);

  useEffect(() => {
    if (article?.extracted) setShowFull(true);
  }, [article?.id, article?.extracted]);

  const html = useMemo(() => {
    if (!article) return '';
    const source = showFull && article.extracted ? article.extracted.contentHtml : article.contentHtml;
    return source ? sanitizeHtml(source) : '';
  }, [article, showFull]);

  if (!article) return null;
  const feed = feeds.get(article.feedId);
  const speakingThis = tts.articleId === article.id && tts.status !== 'idle';

  const loadFull = async () => {
    if (!article.link) return;
    setLoadingFull(true);
    try {
      const r = await api.article(article.link);
      await db.articles.update(article.id, {
        extracted: { text: r.text, contentHtml: r.contentHtml, byline: r.byline, siteName: r.siteName },
        autoSummary: summarize(r.text),
      });
      setShowFull(true);
    } catch (err) {
      toast.error(`Could not load the full article: ${errorMessage(err)}`);
    } finally {
      setLoadingFull(false);
    }
  };

  const summary = article.autoSummary ?? article.summary;

  return (
    <article className="article-view">
      <button className="btn ghost mobile-only" onClick={onBack} style={{ marginBottom: 8 }}>
        <Icon name="chevron-left" /> Back
      </button>
      <div className="small muted row wrap" style={{ marginBottom: 6 }}>
        <span>{feed?.title}</span>
        {(article.extracted?.byline ?? article.author) && <span>· {article.extracted?.byline ?? article.author}</span>}
        <span>· {timeAgo(article.publishedAt)}</span>
      </div>
      <h1>{article.title}</h1>

      <div className="row wrap" style={{ margin: '12px 0' }}>
        <button
          className={`btn${speakingThis ? '' : ' primary'}`}
          onClick={() => (speakingThis ? tts.stop() : void tts.listen(article))}
          disabled={!tts.supported || tts.status === 'loading'}
          title={tts.supported ? 'Read this article aloud' : 'Speech synthesis is not available in this browser'}
        >
          <Icon name={speakingThis ? 'x' : 'headphones'} /> {tts.status === 'loading' && tts.articleId === article.id ? 'Preparing…' : speakingThis ? 'Stop reading' : 'Listen'}
        </button>
        <button className="btn" onClick={() => void db.articles.update(article.id, { starred: article.starred ? 0 : 1 })} aria-pressed={article.starred === 1}>
          <Icon name="star" /> {article.starred ? 'Starred' : 'Star'}
        </button>
        <button className="btn" onClick={() => void db.articles.update(article.id, { read: 0 })}>
          Mark unread
        </button>
        {article.link && (
          <a className="btn" href={article.link} target="_blank" rel="noopener noreferrer">
            <Icon name="external" /> {displayHost(article.link)}
          </a>
        )}
      </div>

      {dup && dup.matches.length > 0 && (
        <section className="dup-panel" aria-label="Possible duplicates">
          <div className="row" style={{ marginBottom: 6 }}>
            <Icon name="merge" />
            <strong>{dup.primaryId === article.id ? 'Other feeds published this story too' : 'This looks like a duplicate of an earlier article'}</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} className="stack">
            {dup.matches.map((m) => {
              const other = dupArticles.get(m.id);
              return (
                <li key={m.id} className="row wrap" style={{ gap: 6 }}>
                  <span className="grow small">
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(m.id);
                      }}
                    >
                      {other?.title ?? `Article ${m.id}`}
                    </a>{' '}
                    <span style={{ opacity: 0.8 }}>
                      — {other ? feeds.get(other.feedId)?.title : ''} · {m.kind === 'exact' ? 'same link' : `${Math.round(m.score * 100)}% similar`}
                    </span>
                  </span>
                  <button className="btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => void markNotDuplicate(article.id, m.id)}>
                    Not a duplicate
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {summary && (
        <section className="summary-box" aria-label="Summary">
          <h3>{article.autoSummary ? 'Summary of the full article' : 'Summary'}</h3>
          <p style={{ margin: 0 }}>{summary}</p>
        </section>
      )}

      {article.link && !article.extracted && (
        <button className="btn" onClick={() => void loadFull()} disabled={loadingFull} style={{ marginBottom: 16 }}>
          <Icon name="file" /> {loadingFull ? 'Loading…' : 'Load full article & summarize'}
        </button>
      )}
      {article.extracted && (
        <div className="row small muted" style={{ marginBottom: 12 }}>
          <div className="seg">
            <button aria-pressed={showFull} onClick={() => setShowFull(true)}>
              Full article
            </button>
            <button aria-pressed={!showFull} onClick={() => setShowFull(false)}>
              From feed
            </button>
          </div>
        </div>
      )}

      {html ? <div className="prose" dangerouslySetInnerHTML={{ __html: html }} /> : !summary && <p className="muted">This feed only provides a link. Use “Load full article” to read it here.</p>}
    </article>
  );
}
