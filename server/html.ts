import { parseHTML } from 'linkedom';
import { truncateAtSentence } from '../shared/text';

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'figure', 'figcaption', 'blockquote', 'pre', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'summary',
]);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'head', 'form', 'button', 'select']);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

function walk(node: DomNode, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== 1) return;
  const name = node.nodeName.toLowerCase();
  if (SKIP.has(name)) return;
  if (name === 'br') {
    out.push('\n');
    return;
  }
  const block = BLOCK.has(name);
  if (block) out.push('\n\n');
  for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]!, out);
  if (block) out.push('\n\n');
}

/**
 * Convert an HTML fragment to plain text. Paragraph structure is kept as blank lines (useful for
 * read-aloud), scripts/styles are dropped, and entities are decoded.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const out: string[] = [];
  walk(document.body as unknown as DomNode, out);
  return out
    .join('')
    .replace(/ /g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-paragraph summary of an HTML fragment, cut at a sentence boundary. */
export function summaryFromHtml(html: string | undefined | null, max = 600): string {
  return truncateAtSentence(htmlToText(html).replace(/\s*\n+\s*/g, ' '), max);
}

/** True when the string contains markup worth rendering as HTML rather than plain text. */
export function looksLikeHtml(s: string): boolean {
  return /<\/?(p|div|br|ul|ol|li|a|img|h[1-6]|strong|em|b|i|blockquote|span|pre|code)\b[^>]*>/i.test(s);
}

/** First <img src> in an HTML fragment. */
export function firstImage(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const m = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  return m?.[1];
}
