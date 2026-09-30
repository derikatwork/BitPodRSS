import type { Chapter, Transcript, TranscriptSegment } from './types';

/** "00:01:02.500", "01:02,500" or "62.5" to seconds. */
export function parseTimestamp(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const CUE_TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** WebVTT and SubRip share a cue structure, so one parser handles both. */
function parseCues(body: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = body.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => CUE_TIME.test(l));
    if (timeIdx < 0) continue;
    const m = CUE_TIME.exec(lines[timeIdx]!)!;
    const raw = lines.slice(timeIdx + 1).join(' ');
    let speaker: string | undefined;
    const voice = /<v(?:\.[^\s>]+)?\s+([^>]+)>/i.exec(raw);
    if (voice) speaker = voice[1]!.trim();
    let text = decodeEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!speaker) {
      const prefix = /^([A-Z][\w .'-]{0,30}):\s+(.*)$/.exec(text);
      if (prefix && /^[A-Z]/.test(prefix[1]!) && prefix[1]!.split(' ').length <= 3) {
        speaker = prefix[1]!;
        text = prefix[2]!;
      }
    }
    if (!text) continue;
    segments.push({ start: parseTimestamp(m[1]!), end: parseTimestamp(m[2]!), speaker, text });
  }
  return segments;
}

function parseJsonTranscript(body: string): TranscriptSegment[] {
  const data = JSON.parse(body) as { segments?: unknown[] };
  if (!Array.isArray(data.segments)) return [];
  const out: TranscriptSegment[] = [];
  for (const raw of data.segments) {
    const s = raw as Record<string, unknown>;
    const text = typeof s['body'] === 'string' ? s['body'] : typeof s['text'] === 'string' ? (s['text'] as string) : '';
    const start = Number(s['startTime'] ?? s['start']);
    const end = Number(s['endTime'] ?? s['end'] ?? start);
    if (!text.trim() || !Number.isFinite(start)) continue;
    out.push({ start, end: Number.isFinite(end) ? end : start, speaker: typeof s['speaker'] === 'string' ? s['speaker'] : undefined, text: text.trim() });
  }
  return out;
}

function untimed(text: string): Transcript {
  const paragraphs = text
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { timed: false, segments: paragraphs.map((p) => ({ start: 0, end: 0, text: p })) };
}

/**
 * Parse a publisher transcript (Podcasting 2.0 `podcast:transcript`). Supports WebVTT, SubRip,
 * the namespace's JSON format, HTML and plain text. `hint` is the declared MIME type or file name.
 */
export function parseTranscript(body: string, hint = ''): Transcript {
  const h = hint.toLowerCase();
  const head = body.trimStart().slice(0, 20);
  let kind: 'vtt' | 'srt' | 'json' | 'html' | 'text';
  if (head.startsWith('WEBVTT') || h.includes('vtt')) kind = 'vtt';
  else if (head.startsWith('{') || h.includes('json')) kind = 'json';
  else if (h.includes('srt') || h.includes('subrip') || CUE_TIME.test(body.slice(0, 500))) kind = 'srt';
  else if (h.includes('html') || /^\s*<(!doctype|html|body|p|div)\b/i.test(body)) kind = 'html';
  else kind = 'text';

  try {
    if (kind === 'vtt' || kind === 'srt') {
      const segments = parseCues(body);
      if (segments.length) return { timed: true, segments };
    } else if (kind === 'json') {
      const segments = parseJsonTranscript(body);
      if (segments.length) return { timed: true, segments };
    } else if (kind === 'html') {
      const text = decodeEntities(
        body
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
          .replace(/<\/(p|div|br|li|h\d)>|<br\s*\/?>/gi, '\n\n')
          .replace(/<[^>]+>/g, ''),
      );
      return untimed(text);
    }
  } catch {
    // fall through to plain text
  }
  return untimed(body);
}

function pad(n: number, w = 2): string {
  return String(Math.floor(n)).padStart(w, '0');
}

function vttTime(sec: number, sep: '.' | ','): string {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms === 1000 ? 999 : ms, 3)}`;
}

export function toVtt(segments: readonly TranscriptSegment[]): string {
  const cues = segments.map((s) => `${vttTime(s.start, '.')} --> ${vttTime(s.end, '.')}\n${s.speaker ? `<v ${s.speaker}>` : ''}${s.text}`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function toSrt(segments: readonly TranscriptSegment[]): string {
  return segments.map((s, i) => `${i + 1}\n${vttTime(s.start, ',')} --> ${vttTime(s.end, ',')}\n${s.text}`).join('\n\n') + '\n';
}

export function toPlainText(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n\n');
}

/** Index of the segment being spoken at time `t` (binary search), or -1 before the first one. */
export function activeSegmentIndex(segments: readonly TranscriptSegment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Parse the Podcasting 2.0 chapters JSON (`{version, chapters: [{startTime, title, ...}]}`). */
export function parseChapters(body: string): Chapter[] {
  const data = JSON.parse(body) as { chapters?: unknown[] };
  if (!Array.isArray(data.chapters)) return [];
  const chapters: Chapter[] = [];
  for (const raw of data.chapters) {
    const c = raw as Record<string, unknown>;
    const startTime = Number(c['startTime']);
    if (!Number.isFinite(startTime) || typeof c['title'] !== 'string') continue;
    chapters.push({
      startTime,
      title: c['title'],
      img: typeof c['img'] === 'string' ? c['img'] : undefined,
      url: typeof c['url'] === 'string' ? c['url'] : undefined,
      toc: c['toc'] === false ? false : undefined,
    });
  }
  return chapters.sort((a, b) => a.startTime - b.startTime);
}

export function activeChapterIndex(chapters: readonly Chapter[], t: number): number {
  let ans = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.startTime <= t) ans = i;
    else break;
  }
  return ans;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
