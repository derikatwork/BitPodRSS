const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into ' +
    'is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than ' +
    'that the their theirs them then there these they this those through to too under until up us very was we were what when where ' +
    'which while who whom why will with would you your yours said says say says'
  ).split(/\s+/),
);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}

/** Lowercase, strip diacritics and collapse whitespace. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into lowercase alphanumeric tokens (unicode aware). */
export function tokenize(input: string, opts: { stopwords?: boolean } = {}): string[] {
  const tokens = normalizeText(input).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  const cleaned = tokens.map((t) => t.replace(/['’]s$/, '').replace(/['’]/g, ''));
  return opts.stopwords ? cleaned.filter((t) => t.length > 0 && !STOPWORDS.has(t)) : cleaned.filter(Boolean);
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp', 'no', 'fig', 'approx', 'gen',
  'sen', 'rep', 'gov', 'lt', 'col', 'sgt', 'capt', 'rev', 'hon', 'mt', 'ft', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
  'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e', 'u.s', 'u.k', 'a.m', 'p.m',
]);

/**
 * Split text into sentences. Handles common abbreviations ("Dr.", "U.S."), decimals ("3.5") and
 * keeps closing quotes/brackets with the sentence they belong to. Newlines always end a sentence.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n+/)) {
    const para = block.trim();
    if (!para) continue;
    const re = /[.!?…]+["'”’)\]]*(?=\s+|$)/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) {
      const end = m.index + m[0].length;
      const candidate = para.slice(start, end);
      const lastWord = /([\p{L}.]+)\.$/u.exec(candidate.replace(/["'”’)\]]+$/, ''));
      const isAbbrev =
        m[0] === '.' && lastWord && (ABBREVIATIONS.has(lastWord[1]!.toLowerCase()) || /^\p{Lu}$/u.test(lastWord[1]!));
      const next = para.slice(end).trimStart();
      // A sentence normally continues with a capital letter, digit or quote; a lowercase start means we split too early.
      const continues = next.length > 0 && /^\p{Ll}/u.test(next) && m[0] === '.';
      if (isAbbrev || continues) continue;
      out.push(candidate.trim());
      start = end;
    }
    const rest = para.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out.filter(Boolean);
}

/** Truncate to at most `max` characters, preferring a sentence boundary, then a word boundary. */
export function truncateAtSentence(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice).replace(/[,;:\-–—\s]+$/, '') + '…';
}

/** Short, non-cryptographic 32-bit FNV-1a hash as hex. For ids and cache keys only. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
