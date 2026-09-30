import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeToPcm, downloadToFile, transcribeStream, type AsrChunk, type AsrFn } from './pipeline';

const SR = 16_000;

/** PCM where every sample holds its own time in seconds, so a fake model can tell where a window starts. */
async function* clock(totalSeconds: number, chunkSamples = 10_000): AsyncGenerator<Float32Array> {
  const total = Math.round(totalSeconds * SR);
  for (let i = 0; i < total; i += chunkSamples) {
    const n = Math.min(chunkSamples, total - i);
    yield Float32Array.from({ length: n }, (_, k) => (i + k) / SR);
  }
}

/**
 * A "speaker" says word k during [k*4, k*4+4). The fake model transcribes every word that starts inside the
 * window, and -- like real Whisper -- reports a word cut off by the window edge as truncated.
 */
function speaker(wordSeconds = 4, totalWords = Infinity): AsrFn {
  return async (window) => {
    const a = window[0]!;
    const len = window.length / SR;
    const out: AsrChunk[] = [];
    for (let k = Math.ceil(a / wordSeconds - 1e-3); k < totalWords; k++) {
      const start = k * wordSeconds - a;
      if (start >= len - 0.05) break;
      const end = start + wordSeconds;
      out.push({ start, end: end > len ? null : end, text: ` w${k}` });
    }
    return out;
  };
}

describe('transcribeStream', () => {
  it('produces every word exactly once, in order, with absolute timestamps, across window boundaries', async () => {
    const seconds = 100;
    const segments = await transcribeStream({ pcm: clock(seconds), asr: speaker(4, seconds / 4) });
    expect(segments.map((s) => s.text)).toEqual(Array.from({ length: 25 }, (_, k) => `w${k}`));
    segments.forEach((s, k) => {
      expect(s.start).toBeCloseTo(k * 4, 2);
      expect(s.end).toBeCloseTo(k * 4 + 4, 2);
    });
  });

  it('works when words do not align with the 30 s window (7 s words)', async () => {
    const seconds = 140;
    const segments = await transcribeStream({ pcm: clock(seconds), asr: speaker(7, seconds / 7) });
    expect(segments.map((s) => s.text)).toEqual(Array.from({ length: 20 }, (_, k) => `w${k}`));
    segments.forEach((s, k) => expect(s.start).toBeCloseTo(k * 7, 2));
  });

  it('handles tiny input chunks, audio shorter than a window, and exact window multiples', async () => {
    const short = await transcribeStream({ pcm: clock(9, 333), asr: speaker(4, 2) });
    expect(short.map((s) => s.text)).toEqual(['w0', 'w1']);
    const exact = await transcribeStream({ pcm: clock(60, 7_777), asr: speaker(5, 12) });
    expect(exact.map((s) => s.text)).toEqual(Array.from({ length: 12 }, (_, k) => `w${k}`));
  });

  it('returns nothing for empty audio and skips silent windows without stalling', async () => {
    expect(await transcribeStream({ pcm: clock(0), asr: speaker() })).toEqual([]);
    const asr = vi.fn<AsrFn>(async () => []);
    expect(await transcribeStream({ pcm: clock(95), asr })).toEqual([]);
    expect(asr).toHaveBeenCalledTimes(4); // 30 + 30 + 30 + 5 seconds
  });

  it('reports progress after each window', async () => {
    const progress: number[] = [];
    await transcribeStream({ pcm: clock(70), asr: speaker(5, 14), onProgress: (_s, processed) => progress.push(Math.round(processed)) });
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[progress.length - 1]).toBe(70);
  });

  it('collapses runaway repetition ("Thank you." x 50) from silence', async () => {
    const asr: AsrFn = async () => Array.from({ length: 10 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: ' Thank you.' }));
    const segments = await transcribeStream({ pcm: clock(20), asr });
    expect(segments.length).toBeLessThanOrEqual(4);
  });

  it('always makes progress even if the model returns a zero-length segment at the start', async () => {
    let calls = 0;
    const asr: AsrFn = async () => (++calls > 50 ? [] : [{ start: 0, end: 0, text: 'x' }, { start: 0, end: null, text: 'y' }]);
    await transcribeStream({ pcm: clock(65), asr });
    expect(calls).toBeLessThan(10);
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    const asr: AsrFn = async (w) => {
      ctrl.abort();
      return speaker()(w);
    };
    await expect(transcribeStream({ pcm: clock(120), asr, signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('decodeToPcm (with a stand-in ffmpeg that passes bytes through)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpod-ffmpeg-'));
    fs.writeFileSync(path.join(dir, 'fake-ffmpeg'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'failing-ffmpeg'), '#!/bin/sh\necho "Invalid data found when processing input" >&2\nexit 1\n', { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  async function collect(gen: AsyncGenerator<Float32Array>): Promise<number[]> {
    const out: number[] = [];
    for await (const c of gen) out.push(...c);
    return out;
  }

  it('reassembles float32 samples even when the byte stream is split at arbitrary positions', async () => {
    vi.stubEnv('FFMPEG_PATH', path.join(dir, 'fake-ffmpeg'));
    const samples = Float32Array.from({ length: 5000 }, (_, i) => Math.fround(Math.sin(i / 10)));
    const bytes = Buffer.from(samples.buffer);
    const pieces: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.subarray(i, i + 7));
    const out = await collect(decodeToPcm(Readable.from(pieces)));
    expect(out).toHaveLength(samples.length);
    expect(out).toEqual([...samples]);
  });

  it('reports a clear error when ffmpeg is missing', async () => {
    vi.stubEnv('FFMPEG_PATH', path.join(dir, 'does-not-exist'));
    await expect(collect(decodeToPcm(Readable.from([Buffer.alloc(8)])))).rejects.toMatchObject({ status: 501, message: /ffmpeg/ });
  });

  it('surfaces ffmpeg decode failures with its own message', async () => {
    vi.stubEnv('FFMPEG_PATH', path.join(dir, 'failing-ffmpeg'));
    await expect(collect(decodeToPcm(Readable.from([Buffer.from('not audio')])))).rejects.toThrow(/Invalid data found/);
  });

  it('kills ffmpeg on abort', async () => {
    vi.stubEnv('FFMPEG_PATH', path.join(dir, 'fake-ffmpeg'));
    const ctrl = new AbortController();
    const endless = Readable.from(
      (async function* () {
        for (;;) {
          yield Buffer.alloc(4096);
          await new Promise((r) => setTimeout(r, 5));
        }
      })(),
    );
    const gen = decodeToPcm(endless, ctrl.signal);
    await gen.next();
    ctrl.abort();
    await expect(collect(gen)).rejects.toThrow();
    endless.destroy();
  });
});

describe('downloadToFile', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpod-dl-'));
    server = http.createServer((req, res) => {
      if (req.url === '/audio') res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '3000' }).end(Buffer.alloc(3000, 1));
      else if (req.url === '/chunked') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        for (let i = 0; i < 10; i++) res.write(Buffer.alloc(1000, 2));
        res.end();
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('downloads to disk and reports progress', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    const dest = path.join(dir, 'a.bin');
    const seen: number[] = [];
    const n = await downloadToFile(`${base}/audio`, dest, { maxBytes: 10_000, onProgress: (b) => seen.push(b) });
    expect(n).toBe(3000);
    expect(fs.statSync(dest).size).toBe(3000);
    expect(seen[seen.length - 1]).toBe(3000);
  });

  it('enforces the size limit both from Content-Length and while streaming', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    await expect(downloadToFile(`${base}/audio`, path.join(dir, 'b.bin'), { maxBytes: 1000 })).rejects.toMatchObject({ status: 413 });
    await expect(downloadToFile(`${base}/chunked`, path.join(dir, 'c.bin'), { maxBytes: 4000 })).rejects.toMatchObject({ status: 413 });
  });

  it('rejects HTTP errors and private hosts', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    await expect(downloadToFile(`${base}/nope`, path.join(dir, 'd.bin'), { maxBytes: 1000 })).rejects.toMatchObject({ status: 502 });
    vi.unstubAllEnvs();
    await expect(downloadToFile(`${base}/audio`, path.join(dir, 'e.bin'), { maxBytes: 10_000 })).rejects.toMatchObject({ status: 403 });
  });
});
