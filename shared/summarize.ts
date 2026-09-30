import { splitSentences, tokenize, truncateAtSentence } from './text';

export interface SummarizeOptions {
  /** Maximum number of sentences. Default 3. */
  sentences?: number;
  /** Maximum characters in the result. Default 500. */
  maxChars?: number;
}

/**
 * Lightweight extractive summary: scores sentences by the frequency of the meaningful words they
 * contain (with a bonus for opening sentences) and returns the best ones in their original order.
 * Runs locally with no model, so it works offline.
 */
export function summarize(text: string, options: SummarizeOptions = {}): string {
  const { sentences: maxSentences = 3, maxChars = 500 } = options;
  const all = splitSentences(text).filter((s) => s.length >= 25 && /[\p{L}]/u.test(s));
  if (all.length === 0) return truncateAtSentence(text, maxChars);
  if (all.length <= maxSentences) return truncateAtSentence(all.join(' '), maxChars);

  const tokenized = all.map((s) => tokenize(s, { stopwords: true }));
  const freq = new Map<string, number>();
  for (const tokens of tokenized) for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const maxFreq = Math.max(...freq.values());

  const scored = all.map((sentence, index) => {
    const tokens = tokenized[index]!;
    if (tokens.length < 4) return { index, score: 0 };
    let sum = 0;
    for (const t of new Set(tokens)) sum += (freq.get(t) ?? 0) / maxFreq;
    // Normalise so long sentences don't win by sheer size, but keep a mild preference for substance.
    const density = sum / Math.sqrt(tokens.length);
    const position = index === 0 ? 1.5 : index < 3 ? 1.2 : 1;
    const lengthPenalty = sentence.length > 320 ? 0.6 : 1;
    return { index, score: density * position * lengthPenalty };
  });

  const picked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((s) => all[s.index]!);

  return truncateAtSentence(picked.join(' '), maxChars);
}
