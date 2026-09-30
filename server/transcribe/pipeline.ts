import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TranscriptSegment } from '../../shared/types';
import { HttpError, safeFetchStream } from '../security';

export const SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------------------------

export function ffmpegPath(): string {
  return process.env['FFMPEG_PATH'] || 'ffmpeg';
}

let ffmpegProbe: { available: boolean; version?: string } | undefined;

/** Whether ffmpeg can be executed. Cached for the life of the process once it succeeds. */
export function probeFfmpeg(force = false): { available: boolean; version?: string } {
  if (ffmpegProbe?.available && !force) return ffmpegProbe;
  const r = spawnSync(ffmpegPath(), ['-version'], { encoding: 'utf8', timeout: 5000 });
  ffmpegProbe = r.status === 0 ? { available: true, version: /ffmpeg version (\S+)/.exec(r.stdout)?.[1] } : { available: false };
  return ffmpegProbe;
}

/**
 * Decode any audio file to 16 kHz mono float32 PCM using ffmpeg, yielding chunks as they are produced.
 *
 * Security: ffmpeg reads the file through stdin and is restricted to the `pipe` protocol, so a crafted
 * playlist (HLS/DASH/concat) cannot make it open local files or fetch other URLs.
 */
export async function* decodeToPcm(input: Readable, signal?: AbortSignal): AsyncGenerator<Float32Array> {
  const child = spawn(
    ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const spawnError = new Promise<never>((_, reject) =>
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(new HttpError(501, e.code === 'ENOENT' ? 'ffmpeg is not installed (or FFMPEG_PATH is wrong). Install ffmpeg to enable transcription.' : `Could not start ffmpeg: ${e.message}`)),
    ),
  );
  spawnError.catch(() => undefined);

  const onAbort = (): void => void child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });
  input.on('error', () => child.kill('SIGKILL'));
  // ffmpeg may legitimately close stdin early (e.g. once it has decoded what it needs).
  child.stdin.on('error', () => undefined);
  input.pipe(child.stdin);

  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = buf.subarray(usable);
      if (usable > 0) {
        // Copy: the Buffer may be a slice of a pooled allocation and Float32Array needs 4-byte alignment.
        const out = new Float32Array(usable / 4);
        Buffer.from(out.buffer).set(buf.subarray(0, usable));
        yield out;
      }
    }
    await Promise.race([exited, spawnError]);
    const code = await exited;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`ffmpeg could not decode this audio${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
  } catch (err) {
    child.kill('SIGKILL');
    throw err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT' ? new HttpError(501, 'ffmpeg is not installed') : err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------------------------

export interface DownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total?: number) => void;
}

/** Download a (public) URL to `dest`, enforcing a size cap. Returns the number of bytes written. */
export async function downloadToFile(url: string, dest: string, opts: DownloadOptions): Promise<number> {
  const res = await safeFetchStream(url, { timeoutMs: 4 * 3600_000, signal: opts.signal, headers: { accept: 'audio/*,video/*;q=0.9,*/*;q=0.5' } });
  if (res.status >= 400) throw new HttpError(502, `The audio server answered HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || undefined;
  if (total && total > opts.maxBytes) throw new HttpError(413, `Audio is larger than the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`);

  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) return cb(new HttpError(413, `Audio is larger than the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`));
      opts.onProgress?.(bytes, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(dest), { signal: opts.signal });
  return bytes;
}

export function openFile(path: string): Readable {
  return createReadStream(path);
}

// ---------------------------------------------------------------------------------------------
// Sliding-window transcription
// ---------------------------------------------------------------------------------------------

export interface AsrChunk {
  /** Seconds from the start of the window. */
  start: number;
  /** Seconds from the start of the window; null when the model was cut off mid-segment. */
  end: number | null;
  text: string;
}

/** Transcribe one window of 16 kHz mono audio (at most 30 s). */
export type AsrFn = (audio: Float32Array) => Promise<AsrChunk[]>;

export interface TranscribeStreamOptions {
  pcm: AsyncIterable<Float32Array>;
  asr: AsrFn;
  signal?: AbortSignal;
  /** Called after each window with the segments it produced (absolute times) and seconds processed so far. */
  onProgress?: (segments: TranscriptSegment[], processedSeconds: number) => void;
  windowSeconds?: number;
  sampleRate?: number;
}

const MAX_REPEATS = 3;

/**
 * Run `asr` over a PCM stream in ~30 s windows.
 *
 * Speech models cut words in half at window edges. When a window is full, the last segment (which may be
 * truncated) is discarded and the next window starts where the last *complete* segment ended, so nothing
 * is lost or split. Silence-induced loops ("Thank you. Thank you. …") are collapsed.
 */
export async function transcribeStream(opts: TranscribeStreamOptions): Promise<TranscriptSegment[]> {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const windowSamples = Math.round((opts.windowSeconds ?? WINDOW_SECONDS) * sampleRate);
  const all: TranscriptSegment[] = [];

  let buffer = new Float32Array(0);
  let bufferStart = 0; // seconds of audio before buffer[0]
  let ended = false;
  const iterator = opts.pcm[Symbol.asyncIterator]();

  const fill = async (): Promise<void> => {
    while (!ended && buffer.length < windowSamples) {
      const { done, value } = await iterator.next();
      if (done) {
        ended = true;
        break;
      }
      const merged = new Float32Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
    }
  };

  let lastText = '';
  let repeats = 0;

  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      await fill();
      if (buffer.length === 0) break;

      const final = ended && buffer.length <= windowSamples;
      const window = buffer.subarray(0, Math.min(windowSamples, buffer.length));
      const windowSeconds = window.length / sampleRate;
      const chunks = (await opts.asr(window)).filter((c) => c.text.trim().length > 0);

      let keep = chunks;
      let advanceSeconds = windowSeconds;
      if (!final && chunks.length > 0) {
        const last = chunks[chunks.length - 1]!;
        const truncated = (last.end ?? windowSeconds) >= windowSeconds - 1;
        if (truncated && chunks.length > 1) keep = chunks.slice(0, -1);
        // Resume where the last kept segment ended, so audio after it (including any word that begins
        // just before the window edge) is presented again at the start of the next window. Always move
        // forward by a meaningful amount to guarantee progress.
        const resumeAt = Math.min(keep[keep.length - 1]!.end ?? windowSeconds, windowSeconds);
        if (resumeAt >= 1) advanceSeconds = resumeAt;
      }

      const segments: TranscriptSegment[] = [];
      for (let i = 0; i < keep.length; i++) {
        const c = keep[i]!;
        const text = c.text.trim();
        if (text === lastText) {
          if (++repeats >= MAX_REPEATS) continue;
        } else {
          lastText = text;
          repeats = 0;
        }
        const start = bufferStart + c.start;
        const next = keep[i + 1];
        const end = bufferStart + (c.end ?? next?.start ?? windowSeconds);
        segments.push({ start, end: Math.max(end, start), text });
      }
      all.push(...segments);

      const advanceSamples = Math.min(buffer.length, Math.max(1, Math.round(advanceSeconds * sampleRate)));
      buffer = buffer.slice(advanceSamples);
      bufferStart += advanceSamples / sampleRate;
      opts.onProgress?.(segments, bufferStart);
      if (final) break;
    }
  } finally {
    await iterator.return?.();
  }
  return all;
}
