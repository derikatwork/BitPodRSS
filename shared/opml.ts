import { XMLParser } from 'fast-xml-parser';

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl?: string;
  /** Name of the enclosing folder, if the feed was inside one. */
  category?: string;
}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'outline',
  processEntities: true,
});

function attr(node: Node, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_') && k.slice(2).toLowerCase() === lower && v != null) return String(v).trim();
  }
  return undefined;
}

function isHttp(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/** Extract every feed from an OPML document. Folders become `category`; duplicate URLs are dropped. */
export function parseOpml(xml: string): OpmlFeed[] {
  const doc = parser.parse(xml) as { opml?: { body?: { outline?: Node[] } } };
  const roots = doc.opml?.body?.outline;
  if (!roots) throw new Error('Not a valid OPML file (no <body><outline> found)');

  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  const walk = (nodes: Node[], category?: string): void => {
    for (const node of nodes) {
      const xmlUrl = attr(node, 'xmlUrl');
      const label = attr(node, 'text') || attr(node, 'title');
      const children = node['outline'] as Node[] | undefined;
      if (isHttp(xmlUrl)) {
        if (!seen.has(xmlUrl)) {
          seen.add(xmlUrl);
          const htmlUrl = attr(node, 'htmlUrl');
          feeds.push({ title: label || xmlUrl, xmlUrl, htmlUrl: isHttp(htmlUrl) ? htmlUrl : undefined, category });
        }
      } else if (children?.length) {
        walk(children, label || category);
      }
    }
  };
  walk(roots);
  return feeds;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface OpmlGroup {
  category?: string;
  feeds: { title: string; xmlUrl: string; htmlUrl?: string }[];
}

export function buildOpml(title: string, groups: OpmlGroup[]): string {
  const line = (f: OpmlGroup['feeds'][number], indent: string): string =>
    `${indent}<outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.xmlUrl)}"${f.htmlUrl ? ` htmlUrl="${esc(f.htmlUrl)}"` : ''}/>`;
  const body = groups
    .filter((g) => g.feeds.length)
    .map((g) =>
      g.category
        ? `    <outline text="${esc(g.category)}" title="${esc(g.category)}">\n${g.feeds.map((f) => line(f, '      ')).join('\n')}\n    </outline>`
        : g.feeds.map((f) => line(f, '    ')).join('\n'),
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${esc(title)}</title>\n  </head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
}
