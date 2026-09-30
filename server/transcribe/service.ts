import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Capabilities, TranscribeJobState, TranscribeStatus, TranscriptSegment } from '../../shared/types';
import { HttpError, assertAllowedUrl } from '../security';
import { WHISPER_MODELS, findModel } from './models';
import { decodeToPcm, downloadToFile, openFile, probeFfmpeg, transcribeStream, type AsrFn, type DownloadOptions } from './pipeline';
import { loadWhisper, whisperStatus } from './whisper';

export interface TranscribeRequest {
  url: string;
  model: string;
  /** ISO 639-1 code for multilingual models; ignored by English-only models. */
  language?: string;
  /** Episode length in seconds, used only to show progress. */
  durationSec?: number;
}

export interface ServiceDeps {
  dataDir: string;
  loadAsr: (model: string, language: string | undefined, onMessage: (m: string) => void) => Promise<AsrFn>;
  download: (url: string, dest: string, opts: DownloadOptions) => Promise<number>;
  decode: (input: Readable, signal?: AbortSignal) => AsyncIterable<Float32Array>;
  ffmpegAvailable: () => boolean;
  maxAudioBytes: number;
}

const FINISHED_JOBS_KEPT = 25;

interface Job {
  id: string;
  key: string;
  req: TranscribeRequest;
  status: TranscribeStatus;
  message?: string;
  error?: string;
  processedSeconds: number;
  segments: TranscriptSegment[];
  controller: AbortController;
  createdAt: number;
}

export function defaultDeps(dataDir: string): ServiceDeps {
  return {
    dataDir,
    loadAsr: (model, language, onMessage) => loadWhisper(model, { cacheDir: path.join(dataDir, 'models'), language, onMessage }),
    download: downloadToFile,
    decode: decodeToPcm,
    ffmpegAvailable: () => probeFfmpeg().available,
    maxAudioBytes: Number(process.env['MAX_AUDIO_MB'] ?? 1024) * 1024 * 1024,
  };
}

/** Runs one transcription at a time, remembers finished transcripts on disk, and exposes progress for polling. */
export class TranscriptionService {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = false;
  private transcriptDir: string;
  private tmpDir: string;

  constructor(private deps: ServiceDeps) {
    this.transcriptDir = path.join(deps.dataDir, 'transcripts');
    this.tmpDir = path.join(deps.dataDir, 'tmp');
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    // Leftovers from a crash.
    for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { force: true });
  }

  async capabilities(): Promise<Capabilities> {
    const whisper = await whisperStatus();
    return {
      ffmpeg: { available: this.deps.ffmpegAvailable() },
      whisper: { ...whisper, models: WHISPER_MODELS, dataDir: this.deps.dataDir },
    };
  }

  start(req: TranscribeRequest): TranscribeJobState {
    assertAllowedUrl(req.url);
    const model = findModel(req.model);
    if (!model) throw new HttpError(400, 'Unknown transcription model');
    const language = model.multilingual && req.language && /^[a-z]{2,3}$/i.test(req.language) ? req.language.toLowerCase() : undefined;
    const request: TranscribeRequest = { url: req.url, model: model.id, language, durationSec: Number.isFinite(req.durationSec) && req.durationSec! > 0 ? req.durationSec : undefined };
    const key = createHash('sha256').update(`${request.url}\n${request.model}\n${request.language ?? ''}`).digest('hex').slice(0, 32);

    // Identical request already queued or running: share it.
    for (const job of this.jobs.values()) {
      if (job.key === key && (job.status === 'queued' || job.status === 'downloading' || job.status === 'transcribing')) return this.snapshot(job, 0);
    }

    const job: Job = { id: randomUUID(), key, req: request, status: 'queued', processedSeconds: 0, segments: [], controller: new AbortController(), createdAt: Date.now() };
    this.jobs.set(job.id, job);

    const cached = this.readCache(key);
    if (cached) {
      job.segments = cached;
      job.status = 'done';
      job.processedSeconds = request.durationSec ?? cached[cached.length - 1]?.end ?? 0;
      job.message = 'Loaded from the local transcript cache';
    } else {
      if (!this.deps.ffmpegAvailable()) {
        this.jobs.delete(job.id);
        throw new HttpError(501, 'ffmpeg was not found. Install ffmpeg (or set FFMPEG_PATH) to transcribe podcasts locally.');
      }
      this.queue.push(job);
      void this.pump();
    }
    this.evict();
    return this.snapshot(job, 0);
  }

  get(id: string, since = 0): TranscribeJobState | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job, since) : undefined;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j !== job);
      job.status = 'cancelled';
    } else if (job.status === 'downloading' || job.status === 'transcribing') {
      job.controller.abort();
    }
    return true;
  }

  private snapshot(job: Job, since: number): TranscribeJobState {
    const duration = job.req.durationSec;
    let progress: number | undefined;
    if (job.status === 'done') progress = 1;
    else if (job.status === 'transcribing' && duration) progress = Math.min(0.99, job.processedSeconds / duration);
    return {
      id: job.id,
      status: job.status,
      progress,
      processedSeconds: job.processedSeconds,
      model: job.req.model,
      message: job.message,
      error: job.error,
      segments: job.segments.slice(Math.max(0, since)),
      total: job.segments.length,
    };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) await this.run(job);
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const { signal } = job.controller;
    const audioPath = path.join(this.tmpDir, `${job.id}.audio`);
    let input: Readable | undefined;
    try {
      job.status = 'downloading';
      // Load the model first: failing fast on a missing engine beats downloading an hour of audio for nothing.
      job.message = 'Loading speech model…';
      const asr = await this.deps.loadAsr(job.req.model, job.req.language, (m) => (job.message = m));
      signal.throwIfAborted();

      job.message = 'Downloading audio…';
      await this.deps.download(job.req.url, audioPath, {
        maxBytes: this.deps.maxAudioBytes,
        signal,
        onProgress: (bytes, total) => {
          job.message = total ? `Downloading audio… ${Math.round((bytes / total) * 100)}%` : `Downloading audio… ${(bytes / 1048576).toFixed(0)} MB`;
        },
      });
      signal.throwIfAborted();

      job.status = 'transcribing';
      job.message = 'Transcribing…';
      input = openFile(audioPath);
      // Nothing may consume this stream if we are cancelled first; an unhandled 'error' would crash the server.
      input.on('error', () => undefined);
      const segments = await transcribeStream({
        pcm: this.deps.decode(input, signal),
        asr,
        signal,
        onProgress: (segs, processed) => {
          job.segments.push(...segs);
          job.processedSeconds = processed;
        },
      });
      if (segments.length === 0) throw new Error('No speech was detected in this audio');
      this.writeCache(job.key, job.segments);
      job.status = 'done';
      job.message = undefined;
    } catch (err) {
      if (signal.aborted) {
        job.status = 'cancelled';
        job.message = undefined;
      } else {
        job.status = 'error';
        job.message = undefined;
        job.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      input?.destroy();
      fs.rmSync(audioPath, { force: true });
    }
  }

  private readCache(key: string): TranscriptSegment[] | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.transcriptDir, `${key}.json`), 'utf8')) as { segments?: TranscriptSegment[] };
      return Array.isArray(data.segments) && data.segments.length ? data.segments : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, segments: TranscriptSegment[]): void {
    const file = path.join(this.transcriptDir, `${key}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ segments, createdAt: Date.now() }));
    fs.renameSync(tmp, file);
  }

  private evict(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_JOBS_KEPT))) this.jobs.delete(job.id);
  }
}
