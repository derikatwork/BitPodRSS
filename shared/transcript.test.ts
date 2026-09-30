import { describe, expect, it } from 'vitest';
import { activeChapterIndex, activeSegmentIndex, formatTime, parseChapters, parseTimestamp, parseTranscript, toPlainText, toSrt, toVtt } from './transcript';

const VTT = `WEBVTT

NOTE a comment

1
00:00:01.000 --> 00:00:04.500
<v Alice>Welcome to the show &amp; thanks for listening.

00:00:04.500 --> 00:00:07.000
<v Bob>Glad to be <i>here</i>.

01:00.000 --> 01:05.250
Short timestamp form.
`;

const SRT = `1
00:00:00,500 --> 00:00:02,000
Hello there.

2
00:00:02,000 --> 00:00:04,000
HOST: General Kenobi.
`;

describe('parseTimestamp', () => {
  it('handles hh:mm:ss.mmm, mm:ss,mmm and plain seconds', () => {
    expect(parseTimestamp('01:02:03.500')).toBe(3723.5);
    expect(parseTimestamp('02:03,250')).toBe(123.25);
    expect(parseTimestamp('62.5')).toBe(62.5);
    expect(parseTimestamp('x')).toBeNaN();
  });
});

describe('parseTranscript', () => {
  it('parses WebVTT with voice tags, entities and short timestamps', () => {
    const t = parseTranscript(VTT, 'text/vtt');
    expect(t.timed).toBe(true);
    expect(t.segments).toEqual([
      { start: 1, end: 4.5, speaker: 'Alice', text: 'Welcome to the show & thanks for listening.' },
      { start: 4.5, end: 7, speaker: 'Bob', text: 'Glad to be here.' },
      { start: 60, end: 65.25, speaker: undefined, text: 'Short timestamp form.' },
    ]);
  });

  it('parses SubRip and recognises "SPEAKER:" prefixes', () => {
    const t = parseTranscript(SRT, 'application/x-subrip');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]).toMatchObject({ start: 0.5, end: 2, text: 'Hello there.' });
    expect(t.segments[1]).toMatchObject({ speaker: 'HOST', text: 'General Kenobi.' });
  });

  it('parses the Podcasting 2.0 JSON format', () => {
    const json = JSON.stringify({ version: '1.0.0', segments: [{ speaker: 'Ann', startTime: 0, endTime: 2.5, body: 'Hi' }, { startTime: 3, endTime: 4, body: '  ' }] });
    const t = parseTranscript(json, 'application/json');
    expect(t).toEqual({ timed: true, segments: [{ start: 0, end: 2.5, speaker: 'Ann', text: 'Hi' }] });
  });

  it('sniffs the format when the declared type is unhelpful', () => {
    expect(parseTranscript(VTT, 'application/octet-stream').timed).toBe(true);
    expect(parseTranscript(SRT, '').timed).toBe(true);
  });

  it('returns untimed paragraphs for HTML and plain text', () => {
    const html = parseTranscript('<html><body><script>x()</script><p>First &amp; foremost.</p><p>Second.</p></body></html>', 'text/html');
    expect(html.timed).toBe(false);
    expect(html.segments.map((s) => s.text)).toEqual(['First & foremost.', 'Second.']);
    const plain = parseTranscript('One.\n\nTwo.', 'text/plain');
    expect(plain.segments.map((s) => s.text)).toEqual(['One.', 'Two.']);
  });

  it('degrades to plain text on malformed JSON', () => {
    expect(parseTranscript('{not json', 'application/json').timed).toBe(false);
  });
});

describe('exporters', () => {
  const segs = [
    { start: 0, end: 1.5, text: 'One', speaker: 'A' },
    { start: 1.5, end: 3661.25, text: 'Two' },
  ];
  it('round-trips through VTT', () => {
    const back = parseTranscript(toVtt(segs), 'text/vtt').segments;
    expect(back).toEqual([
      { start: 0, end: 1.5, speaker: 'A', text: 'One' },
      { start: 1.5, end: 3661.25, speaker: undefined, text: 'Two' },
    ]);
  });
  it('round-trips through SRT', () => {
    const back = parseTranscript(toSrt(segs), 'application/srt').segments;
    expect(back.map((s) => [s.start, s.end, s.text])).toEqual([[0, 1.5, 'One'], [1.5, 3661.25, 'Two']]);
  });
  it('writes plain text with speaker labels', () => {
    expect(toPlainText(segs)).toBe('A: One\n\nTwo');
  });
});

describe('activeSegmentIndex', () => {
  const segs = [0, 5, 10].map((start) => ({ start, end: start + 5, text: 'x' }));
  it('finds the segment containing the time', () => {
    expect(activeSegmentIndex(segs, -1)).toBe(-1);
    expect(activeSegmentIndex(segs, 0)).toBe(0);
    expect(activeSegmentIndex(segs, 7)).toBe(1);
    expect(activeSegmentIndex(segs, 999)).toBe(2);
    expect(activeSegmentIndex([], 3)).toBe(-1);
  });
});

describe('chapters', () => {
  const json = JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 60, title: 'Second' }, { startTime: 0, title: 'Intro', img: 'https://x/i.png' }, { startTime: 'bad', title: 'skip' }, { startTime: 90, title: 'Hidden', toc: false }] });
  it('parses, filters and sorts', () => {
    const c = parseChapters(json);
    expect(c.map((x) => x.title)).toEqual(['Intro', 'Second', 'Hidden']);
    expect(c[0]!.img).toBe('https://x/i.png');
    expect(c[2]!.toc).toBe(false);
  });
  it('finds the active chapter', () => {
    const c = parseChapters(json);
    expect(activeChapterIndex(c, -5)).toBe(-1);
    expect(activeChapterIndex(c, 30)).toBe(0);
    expect(activeChapterIndex(c, 61)).toBe(1);
  });
});

describe('formatTime', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(125)).toBe('2:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });
});
