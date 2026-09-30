import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrFn } from './pipeline';
import { TranscriptionService, type ServiceDeps } from './service';

const SR = 16_000;
async function* clock(seconds: number): AsyncGenerator<Float32Array> {
  const total = seconds * SR;
  for (let i = 0; i < total; i += 16_000) yield Float32Array.from({ length: Math.min(16_000, total - i) }, (_, k) => (i + k) / SR);
}
/** Says word k during [5k, 5k+5). */
const speaker: AsrFn = async (w) => {
  const a = w[0]!;
  const len = w.length / SR;
  const out = [];
  for (let k = Math.ceil(a / 5 - 1e-3); ; k++) {
    const start = k * 5 - a;
    if (start >= len - 0.05) break;
    out.push({ start, end: start + 5 > len ? null : start + 5, text: `w${k}` });
  }
  return out;
};

const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('TranscriptionService', () => {
  let dir: string;
  let deps: ServiceDeps;
  let loadAsr: ReturnType<typeof vi.fn>;
  let download: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK', '1');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpod-svc-'));
    loadAsr = vi.fn(async (_m: string, _l: string | undefined, onMessage: (m: string) => void) => {
      onMessage('Downloading speech model… 50%');
      return speaker;
    });
    download = vi.fn(async (_url: string, dest: string) => {
      fs.writeFileSync(dest, Buffer.alloc(10));
      return 10;
    });
    deps = {
      dataDir: dir,
      loadAsr: loadAsr as never,
      download: download as never,
      decode: () => clock(62),
      ffmpegAvailable: () => true,
      maxAudioBytes: 1000,
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const req = { url: 'https://cdn.example/ep.mp3', model: 'Xenova/whisper-tiny.en', durationSec: 62 };

  it('runs a job to completion, exposing partial results and progress while it works', async () => {
    const svc = new TranscriptionService(deps);
    const started = svc.start(req);
    expect(started.status).toBe('downloading'); // nothing ahead of it, so it starts at once
    await until(() => svc.get(started.id)!.status === 'done');
    const done = svc.get(started.id)!;
    expect(done.progress).toBe(1);
    expect(done.segments.map((s) => s.text)).toEqual(Array.from({ length: 13 }, (_, k) => `w${k}`).slice(0, done.total));
    expect(done.total).toBeGreaterThanOrEqual(12);
    expect(done.segments[1]).toMatchObject({ start: 5, end: 10 });
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]); // audio file cleaned up
  });

  it('supports incremental polling with `since`', async () => {
    const svc = new TranscriptionService(deps);
    const { id } = svc.start(req);
    await until(() => svc.get(id)!.status === 'done');
    const all = svc.get(id)!;
    const tail = svc.get(id, all.total - 2)!;
    expect(tail.segments).toHaveLength(2);
    expect(tail.total).toBe(all.total);
  });

  it('answers repeat requests from the on-disk cache without loading a model', async () => {
    const svc = new TranscriptionService(deps);
    const first = svc.start(req);
    await until(() => svc.get(first.id)!.status === 'done');
    loadAsr.mockClear();
    download.mockClear();
    const second = new TranscriptionService(deps).start(req); // fresh instance: only the disk cache remains
    expect(second.status).toBe('done');
    expect(second.total).toBe(svc.get(first.id)!.total);
    expect(loadAsr).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('shares an identical in-flight request instead of starting another', async () => {
    const svc = new TranscriptionService(deps);
    const a = svc.start(req);
    const b = svc.start(req);
    expect(b.id).toBe(a.id);
  });

  it('runs jobs one at a time, in order', async () => {
    const order: string[] = [];
    deps.download = (async (url: string, dest: string) => {
      order.push(`start ${url}`);
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(dest, 'x');
      order.push(`end ${url}`);
      return 1;
    }) as never;
    const svc = new TranscriptionService(deps);
    const a = svc.start({ ...req, url: 'https://cdn.example/a.mp3' });
    const b = svc.start({ ...req, url: 'https://cdn.example/b.mp3' });
    expect(b.status).toBe('queued'); // waits behind a
    await until(() => svc.get(a.id)!.status === 'done' && svc.get(b.id)!.status === 'done');
    expect(order).toEqual(['start https://cdn.example/a.mp3', 'end https://cdn.example/a.mp3', 'start https://cdn.example/b.mp3', 'end https://cdn.example/b.mp3']);
  });

  it('cancels a running job and removes its temp audio', async () => {
    deps.decode = async function* (_input, signal) {
      for await (const c of clock(600)) {
        signal?.throwIfAborted();
        await new Promise((r) => setTimeout(r, 10));
        yield c;
      }
    };
    const svc = new TranscriptionService(deps);
    const { id } = svc.start(req);
    await until(() => svc.get(id)!.status === 'transcribing');
    expect(svc.cancel(id)).toBe(true);
    await until(() => svc.get(id)!.status === 'cancelled');
    await until(() => fs.readdirSync(path.join(dir, 'tmp')).length === 0);
    expect(svc.cancel('nope')).toBe(false);
  });

  it('cancels a queued job before it starts', async () => {
    let release!: () => void;
    deps.download = (async (_u: string, dest: string) => {
      await new Promise<void>((r) => (release = r));
      fs.writeFileSync(dest, 'x');
      return 1;
    }) as never;
    const svc = new TranscriptionService(deps);
    const a = svc.start({ ...req, url: 'https://cdn.example/a.mp3' });
    const b = svc.start({ ...req, url: 'https://cdn.example/b.mp3' });
    svc.cancel(b.id);
    expect(svc.get(b.id)!.status).toBe('cancelled');
    await until(() => typeof release === 'function');
    release();
    await until(() => svc.get(a.id)!.status === 'done');
    expect(svc.get(b.id)!.status).toBe('cancelled');
  });

  it('reports failures (engine missing, bad audio) as job errors, before downloading when possible', async () => {
    deps.loadAsr = (async () => {
      throw new Error('Local transcription is unavailable: engine missing');
    }) as never;
    const svc = new TranscriptionService(deps);
    const { id } = svc.start(req);
    await until(() => svc.get(id)!.status === 'error');
    expect(svc.get(id)!.error).toMatch(/engine missing/);
    expect(download).not.toHaveBeenCalled();
  });

  it('fails the job when no speech is found', async () => {
    deps.loadAsr = (async () => async () => []) as never;
    const svc = new TranscriptionService(deps);
    const { id } = svc.start(req);
    await until(() => svc.get(id)!.status === 'error');
    expect(svc.get(id)!.error).toMatch(/No speech/);
  });

  it('validates input and requires ffmpeg', () => {
    const svc = new TranscriptionService(deps);
    expect(() => svc.start({ ...req, model: 'evil/model' })).toThrow(/Unknown/);
    expect(() => svc.start({ ...req, url: 'file:///etc/passwd' })).toThrow(/http/);
    const noFfmpeg = new TranscriptionService({ ...deps, ffmpegAvailable: () => false });
    expect(() => noFfmpeg.start(req)).toThrow(/ffmpeg/);
  });

  it('only passes a language to multilingual models', () => {
    const svc = new TranscriptionService(deps);
    svc.start({ ...req, model: 'Xenova/whisper-tiny.en', language: 'fr', url: 'https://cdn.example/1.mp3' });
    svc.start({ ...req, model: 'Xenova/whisper-tiny', language: 'FR', url: 'https://cdn.example/2.mp3' });
    svc.start({ ...req, model: 'Xenova/whisper-tiny', language: 'not a language', url: 'https://cdn.example/3.mp3' });
    return until(() => loadAsr.mock.calls.length === 3).then(() => {
      expect(loadAsr.mock.calls.map((c) => c[1])).toEqual([undefined, 'fr', undefined]);
    });
  });
});
