import { describe, expect, it } from 'vitest';
import { buildSpokenArticle, chunkForSpeech, cleanForSpeech, rankVoices, type VoiceLike } from './speech';

describe('cleanForSpeech', () => {
  it('removes URLs and citation markers', () => {
    expect(cleanForSpeech('See https://example.com/a?b=1 for details[3].')).toBe('See for details.');
  });
  it('expands currency, percentages and common abbreviations', () => {
    expect(cleanForSpeech('It raised $1.5 billion, up 12% vs. last year, e.g. from banks.')).toBe(
      'It raised 1.5 billion dollars, up 12 percent versus last year, for example from banks.',
    );
    expect(cleanForSpeech('Cost: $50 or €20 & £5')).toBe('Cost: 50 dollars or 20 euros and 5 pounds');
    expect(cleanForSpeech('Raised $3M and ₿2')).toBe('Raised 3 million dollars and 2 bitcoin');
  });
  it('keeps paragraph breaks', () => {
    expect(cleanForSpeech('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
  });
});

describe('chunkForSpeech', () => {
  const long = 'This sentence is deliberately rather long, because it has clauses, and it keeps going; and going, until it would be cut off by a naive speech engine that cannot cope with very long utterances at all';
  it('never exceeds the max length and loses no words', () => {
    const text = `${long}. Short one. Another short one!\nSecond paragraph starts here. ${long}.`;
    const chunks = chunkForSpeech(text, 100);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
    const words = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ');
    expect(chunks.flatMap((c) => words(c.text))).toEqual(words(text));
  });
  it('marks paragraph ends', () => {
    const chunks = chunkForSpeech('First para. Still first.\nSecond para.', 200);
    expect(chunks).toEqual([
      { text: 'First para. Still first.', paragraphEnd: true },
      { text: 'Second para.', paragraphEnd: true },
    ]);
  });
  it('hard-splits a single token longer than the limit', () => {
    const chunks = chunkForSpeech('x'.repeat(250), 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
  });
  it('returns nothing for empty text', () => {
    expect(chunkForSpeech('  \n ')).toEqual([]);
  });
});

describe('buildSpokenArticle', () => {
  it('announces title and byline', () => {
    expect(buildSpokenArticle({ title: 'Big news!', byline: 'By Ada Lovelace', body: 'Body text.' })).toBe('Big news. By Ada Lovelace.\nBody text.');
  });
});

describe('rankVoices', () => {
  const v = (name: string, lang: string, localService = true): VoiceLike => ({ name, lang, voiceURI: name, localService });
  const voices = [
    v('eSpeak English', 'en-US'),
    v('Deutsch Natural', 'de-DE'),
    v('Samantha', 'en-US'),
    v('Microsoft Aria Online (Natural)', 'en-US', false),
    v('Google UK English Female', 'en-GB', false),
  ];
  it('puts natural/neural voices first and robotic ones last, dropping other languages', () => {
    const ranked = rankVoices(voices, { lang: 'en-US' }).map((x) => x.name);
    expect(ranked[0]).toBe('Microsoft Aria Online (Natural)');
    expect(ranked[ranked.length - 1]).toBe('eSpeak English');
    expect(ranked).not.toContain('Deutsch Natural');
  });
  it('can prefer on-device voices', () => {
    expect(rankVoices(voices, { lang: 'en-US', preferLocal: true })[0]!.name).toBe('Samantha');
  });
  it('falls back to everything when no voice matches the language', () => {
    expect(rankVoices(voices, { lang: 'ja' })).toHaveLength(voices.length);
  });
});
