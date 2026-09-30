import { describe, expect, it } from 'vitest';
import { summarize } from './summarize';
import { splitSentences, truncateAtSentence, tokenize } from './text';

const ARTICLE = `Researchers at the University of Oslo have built a battery that charges in under five minutes. The battery uses a new silicon anode that swells far less than earlier designs. Lead author Dr. Ingrid Solberg said the anode keeps its capacity after 2,000 charge cycles. The team plans to license the battery technology to two manufacturers next year. Unrelated to the work, the campus cafeteria also reopened on Monday. Independent experts called the results promising but cautioned that the battery has only been tested in small pouch cells. Silicon anodes have long promised higher capacity but suffered from rapid degradation.`;

describe('splitSentences', () => {
  it('does not split on abbreviations, initials or decimals', () => {
    expect(splitSentences('Dr. Smith met Mr. Jones in the U.S. on Monday. It cost 3.5 million dollars.')).toEqual([
      'Dr. Smith met Mr. Jones in the U.S. on Monday.',
      'It cost 3.5 million dollars.',
    ]);
  });
  it('splits on newlines and keeps closing quotes', () => {
    expect(splitSentences('He said "stop!" Then he left.\nNew paragraph here')).toEqual(['He said "stop!"', 'Then he left.', 'New paragraph here']);
  });
});

describe('truncateAtSentence', () => {
  it('prefers a sentence boundary', () => {
    expect(truncateAtSentence('One is here. Two is here. Three is here and is long.', 28)).toBe('One is here. Two is here.');
  });
  it('falls back to a word boundary with an ellipsis', () => {
    expect(truncateAtSentence('alpha beta gamma delta epsilon', 14)).toBe('alpha beta…');
  });
});

describe('tokenize', () => {
  it('lowercases, strips diacritics and optionally stopwords', () => {
    expect(tokenize('Café des Étoiles, the best', { stopwords: true })).toEqual(['cafe', 'des', 'etoiles', 'best']);
  });
});

describe('summarize', () => {
  it('returns at most the requested number of sentences in original order', () => {
    const s = summarize(ARTICLE, { sentences: 2 });
    const sentences = splitSentences(s);
    expect(sentences.length).toBeLessThanOrEqual(2);
    const idx = sentences.map((x) => ARTICLE.indexOf(x));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(idx.every((i) => i >= 0)).toBe(true);
  });
  it('includes the lead sentence for a typical news article', () => {
    expect(summarize(ARTICLE)).toContain('charges in under five minutes');
  });
  it('respects maxChars', () => {
    expect(summarize(ARTICLE, { maxChars: 120 }).length).toBeLessThanOrEqual(121);
  });
  it('handles empty and very short input', () => {
    expect(summarize('')).toBe('');
    expect(summarize('Short.')).toBe('Short.');
  });
});
