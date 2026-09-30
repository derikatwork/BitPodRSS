import { splitSentences } from './text';

export interface SpeechChunk {
  text: string;
  /** True for the last chunk of a paragraph; the player adds a short pause after it. */
  paragraphEnd: boolean;
}

const CURRENCY: Record<string, string> = { $: 'dollars', '€': 'euros', '£': 'pounds', '¥': 'yen', '₿': 'bitcoin' };

/**
 * Turn article text into something a speech engine reads naturally: drop URLs and markup,
 * expand symbols and abbreviations that engines commonly mangle.
 */
export function cleanForSpeech(input: string): string {
  let t = input;
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
  t = t.replace(/\bwww\.\S+/gi, ' ');
  t = t.replace(/\[(?:\d+|edit|citation needed)\]/gi, '');
  t = t.replace(/[*_`#~]{1,}(?=\S)/g, ''); // markdown emphasis / heading markers
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Currency: "$1.5 billion" -> "1.5 billion dollars", "$50" -> "50 dollars"
  t = t.replace(/([$€£¥₿])\s?(\d[\d,]*(?:\.\d+)?)(\s?(?:thousand|million|billion|trillion|[kKmMbB]n?)\b)?/g, (_m, sym: string, num: string, mag?: string) => {
    const magnitude = mag ? expandMagnitude(mag.trim()) : '';
    return `${num}${magnitude ? ' ' + magnitude : ''} ${CURRENCY[sym]}`;
  });
  t = t.replace(/(\d)\s?%/g, '$1 percent');
  t = t.replace(/\s&\s/g, ' and ');
  t = t.replace(/\be\.g\./gi, 'for example');
  t = t.replace(/\bi\.e\./gi, 'that is');
  t = t.replace(/\bvs\.?(?=\s)/gi, 'versus');
  t = t.replace(/\betc\./gi, 'et cetera');
  t = t.replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius').replace(/(\d)\s?°\s?F\b/g, '$1 degrees Fahrenheit');
  t = t.replace(/\s+\+\s+/g, ' plus ');
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function expandMagnitude(m: string): string {
  const k = m.toLowerCase();
  if (k === 'k') return 'thousand';
  if (k === 'm') return 'million';
  if (k === 'b' || k === 'bn') return 'billion';
  return k;
}

/**
 * Break text into chunks that speech engines handle reliably. Chrome silently cuts off long utterances
 * and some engines pause awkwardly on very long sentences, so each chunk is at most `maxLen` characters
 * and ends on a sentence (or, failing that, clause or word) boundary.
 */
export function chunkForSpeech(text: string, maxLen = 220): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const pieces: string[] = [];
    let current = '';
    for (const sentence of splitSentences(paragraph)) {
      for (const part of splitLong(sentence, maxLen)) {
        if (current && current.length + 1 + part.length > maxLen) {
          pieces.push(current);
          current = part;
        } else {
          current = current ? `${current} ${part}` : part;
        }
      }
    }
    if (current) pieces.push(current);
    pieces.forEach((p, i) => chunks.push({ text: p, paragraphEnd: i === pieces.length - 1 }));
  }
  return chunks;
}

function splitLong(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(': '), window.lastIndexOf(' — '));
    if (cut < maxLen * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLen - 1; // a single enormous token; hard split
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Build the full text to read: title, byline, then the body. */
export function buildSpokenArticle(parts: { title: string; byline?: string; siteName?: string; body: string }): string {
  const head = [parts.title.replace(/[.!?]+$/, '') + '.'];
  if (parts.byline) head.push(`By ${parts.byline.replace(/^by\s+/i, '').trim()}.`);
  else if (parts.siteName) head.push(`From ${parts.siteName}.`);
  return cleanForSpeech(head.join(' ') + '\n' + parts.body);
}

export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default?: boolean;
}

export interface VoiceRankOptions {
  /** BCP-47 language of the article, e.g. "en" or "en-GB". Defaults to "en". */
  lang?: string;
  /** Prefer voices that run on this device (no text is sent to a cloud service). */
  preferLocal?: boolean;
}

/** Heuristic quality score; higher is more natural. Exported for tests. */
export function scoreVoice(v: VoiceLike, opts: VoiceRankOptions = {}): number {
  const want = (opts.lang ?? 'en').toLowerCase().replace('_', '-');
  const have = v.lang.toLowerCase().replace('_', '-');
  let score = 0;
  if (have === want) score += 100;
  else if (have.split('-')[0] === want.split('-')[0]) score += 70;
  else score -= 10_000;

  if (/natural|neural|premium|enhanced|studio|wavenet/i.test(v.name)) score += 50;
  if (/\bonline\b/i.test(v.name)) score += 10;
  if (/google|microsoft|siri/i.test(v.name)) score += 15;
  if (/espeak|festival|flite|compact|novelty|whisper|bad news|bells|cellos|boing|organ|zarvox|trinoids|albert|jester/i.test(v.name)) score -= 80;
  if (v.default) score += 3;
  // A privacy preference rather than a nudge: on-device voices always outrank cloud voices of the right language.
  if (opts.preferLocal && v.localService) score += 500;
  return score;
}

/** Best voice first. Voices in other languages are dropped unless nothing matches. */
export function rankVoices<T extends VoiceLike>(voices: readonly T[], opts: VoiceRankOptions = {}): T[] {
  const scored = voices.map((v) => ({ v, s: scoreVoice(v, opts) })).sort((a, b) => b.s - a.s);
  const matching = scored.filter((x) => x.s > -5_000);
  return (matching.length ? matching : scored).map((x) => x.v);
}
