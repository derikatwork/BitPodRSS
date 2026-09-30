import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ExtractedArticle } from '../shared/types';
import { stripSiteSuffix } from '../shared/dedupe';
import { absoluteUrl } from '../shared/url';
import { decodeBody } from './charset';
import { htmlToText } from './html';
import { HttpError, safeFetch } from './security';
import { parseDate } from './feed/parse';

const MIN_ARTICLE_CHARS = 100;

interface El {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Drop "| Site Name" / "Site Name - " decoration from a page title, using the site name when known. */
export function cleanTitle(title: string, siteName?: string): string {
  const t = title.trim();
  if (siteName) {
    const site = escapeRegExp(siteName.trim());
    const stripped = t
      .replace(new RegExp(`\\s*[|\\-–—:•·]\\s*${site}\\s*$`, 'i'), '')
      .replace(new RegExp(`^\\s*${site}\\s*[|\\-–—:•·]\\s*`, 'i'), '');
    if (stripped && stripped !== t) return stripped;
  }
  return stripSiteSuffix(t);
}

/** Make links and media in extracted HTML absolute (linkedom has no base URI, so Readability can't). */
function absolutize(root: { querySelectorAll(sel: string): Iterable<El> }, base: string): void {
  for (const a of root.querySelectorAll('a[href]')) {
    const abs = absoluteUrl(a.getAttribute('href') ?? '', base);
    if (abs) a.setAttribute('href', abs);
    else a.removeAttribute('href'); // drops javascript: and other non-http(s) schemes
  }
  for (const img of root.querySelectorAll('img[src], source[src], video[src], audio[src]')) {
    const abs = absoluteUrl(img.getAttribute('src') ?? '', base);
    if (abs) img.setAttribute('src', abs);
    else img.removeAttribute('src');
  }
}

/**
 * Parse an HTML page into its readable article. Pure (no network) so it can be tested directly.
 */
export function extractFromHtml(html: string, pageUrl: string): ExtractedArticle {
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { keepClasses: false });
  const parsed = reader.parse();
  if (!parsed || !parsed.content) throw new HttpError(422, 'Could not find a readable article on this page');

  const { document: fragment } = parseHTML(`<!doctype html><html><body>${parsed.content}</body></html>`);
  absolutize(fragment as unknown as { querySelectorAll(sel: string): Iterable<El> }, pageUrl);

  const byline = parsed.byline?.replace(/^by\s+/i, '').trim() || undefined;
  // Readability often leaves the byline line at the top of the body; the reader announces it separately.
  if (byline) {
    const firstP = fragment.querySelector('p') as unknown as { textContent: string | null; remove(): void } | null;
    const firstText = firstP?.textContent?.trim() ?? '';
    if (firstP && firstText.length < 120 && firstText.toLowerCase().includes(byline.toLowerCase())) firstP.remove();
  }
  const contentHtml = (fragment.body as unknown as { innerHTML: string }).innerHTML;
  const text = htmlToText(contentHtml);
  // Readability always returns its best guess; a couple of words is a failed extraction, not an article.
  if (text.length < MIN_ARTICLE_CHARS) throw new HttpError(422, 'Could not find a readable article on this page');

  return {
    url: pageUrl,
    title: cleanTitle(parsed.title ?? '', parsed.siteName ?? undefined) || pageUrl,
    byline,
    siteName: parsed.siteName?.trim() || undefined,
    lang: parsed.lang?.trim() || undefined,
    excerpt: parsed.excerpt?.trim() || undefined,
    contentHtml,
    text,
    publishedAt: parseDate(parsed.publishedTime ?? undefined),
  };
}

/** Download a page and extract its readable article. */
export async function extractArticle(url: string): Promise<ExtractedArticle> {
  const res = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
  if (res.status >= 400) throw new HttpError(502, `The site answered HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type && !/html|xml|text\/plain/i.test(type)) throw new HttpError(415, `Not a web page (${type.split(';')[0]})`);
  const html = decodeBody(res.body, type);
  return extractFromHtml(html, res.url);
}
