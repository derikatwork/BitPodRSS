import type { DuplicateInfo } from '../../../shared/dedupe';
import { Icon } from '../../components/Icon';
import type { Article, Feed } from '../../db';
import { timeAgo } from '../../lib/format';

export function dupLabel(info: DuplicateInfo, articleId: number): { text: string; title: string } {
  if (info.primaryId === articleId) {
    const n = info.size - 1;
    return { text: `Also in ${n} other feed${n === 1 ? '' : 's'}`, title: 'This is the earliest copy; other feeds published the same story.' };
  }
  const best = info.matches[0];
  const text = best?.kind === 'exact' ? 'Duplicate' : best?.kind === 'likely' ? 'Likely duplicate' : 'Possible duplicate';
  return { text, title: `Matches an earlier article (${Math.round((best?.score ?? 0) * 100)}% similar)` };
}

interface Props {
  articles: Article[];
  feeds: Map<number, Feed>;
  dupInfo: Map<number, DuplicateInfo>;
  selectedId?: number;
  onSelect: (a: Article) => void;
}

export function ArticleList({ articles, feeds, dupInfo, selectedId, onSelect }: Props) {
  return (
    <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {articles.map((a) => {
        const info = dupInfo.get(a.id);
        const label = info ? dupLabel(info, a.id) : undefined;
        return (
          <li key={a.id}>
            <button className={`article-item${a.read ? ' read' : ''}${info ? ' is-dup' : ''}`} aria-current={selectedId === a.id} onClick={() => onSelect(a)}>
              <div className="meta">
                {!a.read && <span className="unread-dot" aria-label="Unread" />}
                <span className="ellipsis">{feeds.get(a.feedId)?.title ?? 'Feed'}</span>
                <span>·</span>
                <time dateTime={new Date(a.publishedAt).toISOString()}>{timeAgo(a.publishedAt)}</time>
                {a.starred === 1 && <Icon name="star" size={12} />}
              </div>
              <div className="title clamp-2">{a.title}</div>
              {a.summary && <div className="small secondary clamp-2" style={{ marginTop: 2 }}>{a.summary}</div>}
              {label && (
                <div style={{ marginTop: 6 }}>
                  <span className="badge dup" title={label.title}>
                    <Icon name="merge" size={12} /> {label.text}
                  </span>
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
