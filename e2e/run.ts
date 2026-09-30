/**
 * End-to-end smoke test: a real browser drives the built app against local fixture feeds.
 *   npm run e2e        (builds first)
 * External services (prices, transcription engine) are replaced with deterministic fakes; everything
 * else, including the feed proxy, parser, database and UI, is the real thing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createApp } from '../server/app';
import { BtcService } from '../server/btc';
import { TranscriptionService } from '../server/transcribe/service';
import { downloadToFile } from '../server/transcribe/pipeline';
import { startFixtures } from './fixtures';

process.env['ALLOW_PRIVATE_NETWORK'] = '1';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = path.join(root, 'e2e', 'screenshots');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

const DAY = 86_400_000;

function fakeBtc(): BtcService {
  const now = Date.now();
  return new BtcService({
    now: () => now,
    fetchJson: async (url) => {
      const u = new URL(url);
      const days = Number(u.searchParams.get('days'));
      const step = days > 90 ? DAY : 3_600_000;
      const prices: [number, number][] = [];
      for (let t = now - days * DAY; t < now; t += step) {
        const x = (t - (now - 365 * DAY)) / DAY;
        prices.push([t, 60_000 + x * 40 + Math.sin(x / 9) * 2500 + Math.sin(t / 3_600_000 / 5) * 300]);
      }
      prices.push([now, 98_765.43]);
      return { prices };
    },
  });
}

function fakeTranscription(dataDir: string): TranscriptionService {
  return new TranscriptionService({
    dataDir,
    loadAsr: async () => async () => [
      { start: 0.5, end: 3, text: ' Welcome to the local transcript.' },
      { start: 3, end: 6, text: ' This was produced on your own machine.' },
    ],
    download: downloadToFile, // real download from the fixture server
    decode: async function* () {
      yield new Float32Array(16_000 * 8);
    },
    ffmpegAvailable: () => true,
    maxAudioBytes: 50 * 1024 * 1024,
  });
}

const FAKE_SPEECH = `
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.rate = 1; } };
  const synth = {
    speaking: false,
    getVoices: () => [
      { name: 'eSpeak English', lang: 'en-US', voiceURI: 'espeak', localService: true, default: false },
      { name: 'Test Natural Voice', lang: 'en-US', voiceURI: 'natural', localService: true, default: true },
    ],
    speak(u) { window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name }); setTimeout(() => u.onend && u.onend({}), 15); },
    cancel() {},
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
`;

const FAKE_EXTENSIONS = `
  window.__keysends = [];
  window.__payments = [];
  window.__balance = 50000;
  window.webln = {
    enable: async () => {},
    getInfo: async () => ({ node: { alias: 'Test Node', pubkey: '02' + 'ab'.repeat(32) }, methods: ['keysend', 'sendPayment', 'makeInvoice'] }),
    getBalance: async () => ({ balance: window.__balance }),
    sendPayment: async (pr) => { window.__payments.push(pr); return { preimage: 'pre' }; },
    keysend: async (a) => { window.__keysends.push(a); window.__balance -= Number(a.amount); return { preimage: 'pre' }; },
    makeInvoice: async (a) => ({ paymentRequest: 'lnbc' + a.amount + 'testinvoice' }),
  };
  window.nostr = {
    getPublicKey: async () => '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
    signEvent: async (e) => ({ ...e, id: 'f'.repeat(64), pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', sig: 'e'.repeat(128) }),
  };
`;

let browser: Browser;
const results: { name: string; ok: boolean; error?: string }[] = [];

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: (err as Error).message });
    console.log(`  ✗ ${name}\n      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`);
    await page.screenshot({ path: path.join(shots, `FAIL-${name.replace(/\W+/g, '-').slice(0, 50)}.png`), fullPage: true }).catch(() => undefined);
  }
}

async function addFeed(page: Page, url: string): Promise<void> {
  await page.locator('button[aria-label="Add feed"]').click();
  await page.getByLabel(/Feed or website address/).fill(url);
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}

async function main(): Promise<void> {
  const fixtures = await startFixtures();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitpod-e2e-'));
  const transcription = fakeTranscription(dataDir);
  // The real capability probe looks for ffmpeg and the Whisper engine, which this test fakes.
  transcription.capabilities = async () => ({
    ffmpeg: { available: true },
    whisper: { available: true, models: [{ id: 'Xenova/whisper-base.en', label: 'Base (English) – balanced', multilingual: false, approxMb: 75 }, { id: 'Xenova/whisper-tiny.en', label: 'Tiny (English) – fastest', multilingual: false, approxMb: 40 }], dataDir },
  });
  const app = createApp({ dataDir, staticDir: path.join(root, 'dist'), btc: fakeBtc(), transcription });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const appUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

  const executablePath = process.env['CHROMIUM_PATH'] ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: [] });
  await context.addInitScript(FAKE_SPEECH);
  await context.addInitScript(FAKE_EXTENSIONS);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('dialog', (d) => void d.accept());
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // Expected noise: the OPML test deliberately imports a dead feed (502), and Nostr relays are unreachable from CI.
  const expectedNoise = [/favicon/, /status of 502/, /WebSocket connection to 'wss:\/\//];
  page.on('console', (m) => m.type() === 'error' && !expectedNoise.some((re) => re.test(m.text())) && pageErrors.push(`console: ${m.text()}`));

  console.log(`\nApp ${appUrl}  fixtures ${fixtures.base}\n`);
  await page.goto(appUrl);

  console.log('Reader');
  await step(page, 'empty state invites adding a feed', async () => {
    await page.getByText('Welcome to BitPodRSS').waitFor();
  });

  await step(page, 'adds feeds (RSS, RSS, Atom) and lists their articles', async () => {
    await addFeed(page, `${fixtures.base}/wire-one.xml`);
    await addFeed(page, `${fixtures.base}/wire-two.xml`);
    await addFeed(page, `${fixtures.base}/blog.atom`);
    await page.getByRole('button', { name: 'All articles' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.article-item').length === 7);
  });

  await step(page, 'highlights duplicates across feeds (same story, same URL)', async () => {
    const fed = page.locator('.article-item', { hasText: 'Fed holds interest rates' });
    assert.equal(await fed.count(), 2);
    for (let i = 0; i < 2; i++) assert.ok(await fed.nth(i).evaluate((el) => el.classList.contains('is-dup')), 'Fed story copy is highlighted');
    const chip = page.locator('.article-item', { hasText: 'Chipmaker unveils' });
    assert.equal(await chip.count(), 2);
    assert.ok((await page.locator('.article-item .badge.dup').count()) >= 4);
    assert.equal(await page.locator('.article-item.is-dup').count(), 4, 'only the two duplicate stories are flagged');
    assert.match((await page.locator('.article-item', { hasText: 'Chipmaker unveils' }).locator('.badge.dup').allTextContents()).join('|'), /Duplicate/);
  });

  await step(page, '"Possible duplicates" view and "Hide duplicates" work', async () => {
    await page.getByRole('button', { name: /Possible duplicates/ }).click();
    assert.equal(await page.locator('.article-item').count(), 4);
    await page.getByRole('button', { name: 'All articles' }).click();
    await page.getByLabel('Hide duplicates').check();
    assert.equal(await page.locator('.article-item').count(), 5);
    await page.getByLabel('Hide duplicates').uncheck();
    assert.equal(await page.locator('.article-item').count(), 7);
  });

  await step(page, 'article view: summary, duplicate panel, dismissing a false positive', async () => {
    await page.locator('.article-item', { hasText: 'Fed holds interest rates' }).first().click();
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByRole('region', { name: 'Summary' }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Summary' }).innerText(), /Federal Reserve left its benchmark/);
    const panel = page.getByRole('region', { name: 'Possible duplicates' });
    await panel.waitFor();
    await page.screenshot({ path: path.join(shots, 'reader-duplicates.png') });
    await panel.getByRole('button', { name: 'Not a duplicate' }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.article-item.is-dup').length === 2);
  });

  await step(page, 'loads the full article and summarizes it', async () => {
    await page.locator('.article-item', { hasText: 'Chipmaker unveils' }).first().click();
    await page.getByRole('button', { name: /Load full article/ }).click();
    await page.getByRole('region', { name: 'Summary' }).filter({ hasText: 'Summary of the full article' }).waitFor();
    assert.match(await page.locator('.prose').innerText(), /Paragraph about chip/);
  });

  await step(page, 'reads an article aloud with the most natural voice, cleaned text and chunking', async () => {
    await page.getByRole('button', { name: 'Listen' }).click();
    await page.getByRole('region', { name: 'Read aloud' }).waitFor();
    await page.waitForFunction(() => (window as unknown as { __spoken: unknown[] }).__spoken.length >= 3);
    const spoken = await page.evaluate(() => (window as unknown as { __spoken: { text: string; voice: string }[] }).__spoken);
    assert.match(spoken[0]!.text, /^Chipmaker unveils new data center processor\./);
    assert.ok(spoken.every((s) => s.voice === 'Test Natural Voice'), 'picked the natural voice over eSpeak');
    assert.ok(spoken.every((s) => s.text.length <= 220));
    await page.screenshot({ path: path.join(shots, 'reader-tts.png') });
    await page.getByRole('button', { name: 'Stop reading' }).first().click();
  });

  await step(page, 'sorts a feed into a new category by drag and drop, and by dialog', async () => {
    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByLabel('Name').fill('Wires');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Wires', exact: true }).waitFor();
    await page.locator('.side-item', { hasText: 'Wire One' }).dragTo(page.getByRole('button', { name: 'Wires', exact: true }));
    await page.locator('.side-item.sub', { hasText: 'Wire One' }).waitFor();
    await page.getByRole('button', { name: 'Manage Wire Two' }).click();
    await page.getByRole('dialog').getByLabel('Category').selectOption({ label: 'Wires' });
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.side-item.sub').length === 2);
    await page.getByRole('button', { name: /^Wires\b/ }).first().click(); // name includes the unread badge
    await page.waitForFunction(() => document.querySelectorAll('.article-item').length === 6); // both wires, not the blog
    await page.screenshot({ path: path.join(shots, 'reader-categories.png') });
  });


  const nav = async (label: string) => page.locator('.nav button', { hasText: label }).click();
  const playerRegion = () => page.getByRole('region', { name: 'Podcast player' });
  const seekValue = () => page.evaluate(() => Number((document.querySelector('input[aria-label="Seek"]') as HTMLInputElement | null)?.value ?? -1));
  const waitSeek = (min: number, timeout = 20_000) => page.waitForFunction((m) => Number((document.querySelector('input[aria-label="Seek"]') as HTMLInputElement | null)?.value ?? -1) >= m, min, { timeout });
  const keysends = () => page.evaluate(() => (window as unknown as { __keysends: { destination: string; amount: number; customRecords: Record<string, string> }[] }).__keysends);

  // ============================== Security ==============================
  console.log('\nSecurity');
  await step(page, 'hostile feed content cannot run script (img onerror, <script>, javascript: links, iframes, forms, svg)', async () => {
    await nav('Reader');
    await addFeed(page, `${fixtures.base}/evil.xml`);
    await page.locator('.article-item', { hasText: 'Innocent looking post' }).click();
    await page.locator('.prose').waitFor();
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      xss: (window as unknown as { __xss?: string }).__xss,
      scripts: document.querySelectorAll('.prose script').length,
      frames: document.querySelectorAll('.prose iframe').length,
      forms: document.querySelectorAll('.prose form, .prose input').length,
      handlers: [...document.querySelectorAll('.prose *')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
      jsLinks: [...document.querySelectorAll('.prose a')].filter((a) => (a.getAttribute('href') ?? '').startsWith('javascript:')).length,
      text: (document.querySelector('.prose') as HTMLElement).innerText,
    }));
    assert.equal(r.xss, undefined, `script ran: ${r.xss}`);
    assert.deepEqual([r.scripts, r.frames, r.forms, r.handlers, r.jsLinks], [0, 0, 0, 0, 0]);
    assert.match(r.text, /Hello/);
  });

  // ============================== Podcasts ==============================
  console.log('\nPodcasts');
  await step(page, 'adds a Podcasting 2.0 podcast by feed URL', async () => {
    await nav('Podcasts');
    await page.getByText('Add your first podcast').waitFor();
    await page.locator('button[aria-label="Add podcast"]').click();
    await page.getByLabel(/Podcast RSS feed URL/).fill(`${fixtures.base}/podcast.xml`);
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('heading', { name: 'Sats & Stories' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.episode').length === 3);
    assert.match(await page.locator('.badge', { hasText: 'Value-for-value' }).first().innerText(), /suggests 15 sats\/min/);
    await page.screenshot({ path: path.join(shots, 'podcast-detail.png') });
  });

  await step(page, 'a podcast added from the Reader is routed to Podcasts (and duplicates are refused)', async () => {
    await nav('Reader');
    await page.locator('button[aria-label="Add feed"]').click();
    await page.getByLabel(/Feed or website address/).fill(`${fixtures.base}/podcast.xml`);
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText(/already subscribed/).waitFor();
    await nav('Podcasts');
  });

  await step(page, 'episode page: persons, chapters and the publisher transcript load (via the server, no CORS needed)', async () => {
    await page.locator('.episode', { hasText: 'Episode 2' }).locator('.ep-title').click();
    await page.getByRole('heading', { level: 1, name: /Episode 2/ }).waitFor();
    await page.locator('.badge', { hasText: 'Grace Guest' }).waitFor();
    await page.getByRole('tab', { name: /Chapters \(3\)/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.cue').length === 3);
    assert.deepEqual(await page.locator('.cue span').allInnerTexts(), ['Intro', 'Lightning deep dive', 'Wrap up']);
    await page.getByRole('tab', { name: 'Transcript' }).click();
    await page.locator('.transcript .cue').first().waitFor();
    assert.equal(await page.locator('.transcript .cue').count(), 3);
    assert.match(await page.locator('.transcript').innerText(), /Ada: Welcome to Sats and Stories\./);
    await page.locator('.badge', { hasText: 'From the publisher' }).waitFor();
  });

  await step(page, 'plays real audio; the transcript follows playback; clicking a line seeks', async () => {
    await page.getByRole('button', { name: 'Play', exact: true }).first().click();
    await playerRegion().waitFor();
    await waitSeek(1);
    await page.locator('.transcript .cue.active').waitFor();
    await page.screenshot({ path: path.join(shots, 'podcast-episode-playing.png') });
    await page.locator('.transcript .cue').nth(2).click();
    await waitSeek(6);
    assert.ok((await seekValue()) >= 6);
    assert.equal(await page.locator('.transcript .cue.active').count(), 1);
    await playerRegion().getByRole('button', { name: 'Pause' }).click();
    await playerRegion().getByRole('button', { name: 'Play' }).waitFor();
  });

  await step(page, 'queues: add episodes, reorder, play the queue, and it advances automatically', async () => {
    await page.getByRole('button', { name: /^Back/ }).first().click(); // episode -> podcast
    await page.getByRole('heading', { name: 'Sats & Stories' }).waitFor();
    const row = (t: string) => page.locator('.episode', { hasText: t });
    await row('Episode 2').getByRole('button', { name: 'Add to queue' }).click();
    await row('Episode 1').getByRole('button', { name: 'Add to queue' }).click();
    await page.locator('.side-item', { hasText: 'Up next' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.episode').length === 2);
    assert.match((await page.locator('.episode').first().innerText()), /Episode 2/);
    await page.locator('.episode').first().getByRole('button', { name: 'Move down' }).click();
    await page.waitForFunction(() => /Episode 1/.test((document.querySelector('.episode') as HTMLElement).innerText));
    await page.getByRole('button', { name: 'Play queue' }).click();
    await playerRegion().getByText('Episode 1: Beginnings').waitFor();
    await waitSeek(1);
    await playerRegion().getByLabel('Seek').press('End'); // jump to the end: the episode finishes
    await playerRegion().getByText('Episode 2: Lightning and Podcasts').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll('.episode').length === 1); // finished episode left the queue
    await page.screenshot({ path: path.join(shots, 'podcast-queue.png') });
    await playerRegion().getByRole('button', { name: 'Close player' }).click();
  });

  await step(page, 'groups: create groups, assign a podcast to several, and drag one onto another group', async () => {
    await page.locator('button[aria-label="New group"]').click();
    await page.getByRole('dialog').getByLabel('Name').fill('Bitcoin');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.locator('button[aria-label="New group"]').click();
    await page.getByRole('dialog').getByLabel('Name').fill('News');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.locator('.side-item.sub', { hasText: 'Sats & Stories' }).click();
    await page.getByRole('button', { name: /Groups & settings/ }).click();
    await page.getByRole('dialog').getByLabel('Bitcoin').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.side-item.sub').length === 1); // now listed under Bitcoin
    await page.locator('.side-item.sub', { hasText: 'Sats & Stories' }).dragTo(page.locator('.side-item', { hasText: /^News$/ }));
    await page.waitForFunction(() => document.querySelectorAll('.side-item.sub').length === 2); // listed under both groups
  });

  await step(page, 'local transcription: progress, then a synced transcript saved on this device, with export', async () => {
    await page.locator('.side-item.sub', { hasText: 'Sats & Stories' }).first().click();
    await page.locator('.episode', { hasText: 'Episode 1' }).locator('.ep-title').click();
    await page.getByRole('tab', { name: 'Transcript' }).click();
    await page.getByText(/does not include a transcript/).waitFor();
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await page.locator('.transcript .cue').first().waitFor({ timeout: 20_000 });
    await page.locator('.badge', { hasText: /Transcribed on this device/ }).waitFor();
    assert.match(await page.locator('.transcript').innerText(), /Welcome to the local transcript\./);
    assert.match(await page.locator('.transcript').innerText(), /produced on your own machine/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /VTT/ }).click()]);
    const vtt = fs.readFileSync((await download.path())!, 'utf8');
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /00:00:00\.500 --> 00:00:03\.000\nWelcome to the local transcript\./);
    await page.screenshot({ path: path.join(shots, 'podcast-transcribe.png') });
  });

  await step(page, 'audio focus: read-aloud pauses a playing podcast, and resuming the podcast stops the speech', async () => {
    await nav('Podcasts');
    await page.locator('.side-item', { hasText: 'Latest episodes' }).click();
    await page.locator('.episode', { hasText: 'Episode 3' }).getByRole('button', { name: /^Play Episode 3/ }).click();
    await playerRegion().getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await nav('Reader');
    await page.getByRole('button', { name: 'All articles' }).click();
    await page.locator('.article-item', { hasText: 'Local bakery' }).click();
    await page.getByRole('button', { name: 'Listen' }).click();
    await page.getByRole('region', { name: 'Read aloud' }).waitFor();
    await playerRegion().getByRole('button', { name: 'Play', exact: true }).waitFor(); // the podcast was paused for the speech
    await playerRegion().getByRole('button', { name: 'Play', exact: true }).click();
    await playerRegion().getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Read aloud' }).waitFor({ state: 'detached' }); // speech stopped for the podcast
    await playerRegion().getByRole('button', { name: 'Pause', exact: true }).click();
    await playerRegion().getByRole('button', { name: 'Close player' }).click();
  });

  // ============================== Bitcoin ==============================
  console.log('\nBitcoin price');
  await step(page, 'shows the current price and 1W / 1M / 1Y / YTD changes', async () => {
    await nav('Bitcoin');
    await page.locator('.btc-hero').waitFor();
    assert.match(await page.locator('.btc-hero').innerText(), /\$98,765/);
    const tiles = page.locator('.tile');
    assert.equal(await tiles.count(), 4);
    assert.deepEqual(await tiles.locator('.label').allInnerTexts(), ['1 week', '1 month', '1 year', 'Year to date']);
    for (const i of [2, 3]) assert.match(await tiles.nth(i).locator('.value').innerText(), /^\+\d/, 'the fake market rose over the year');
    assert.equal(await page.locator('.tile[aria-pressed="true"]').count(), 1);
    await page.locator('.chip', { hasText: '₿' }).waitFor();
  });

  await step(page, 'chart: selecting a period redraws; crosshair tooltip on hover and by keyboard; table twin', async () => {
    const before = await page.locator('svg[role="img"] path').nth(1).getAttribute('d');
    await page.locator('.tile', { hasText: '1 year' }).click();
    assert.equal(await page.locator('.tile[aria-pressed="true"]').innerText().then((t) => /1 year/.test(t)), true);
    await page.waitForFunction((b) => document.querySelectorAll('svg[role="img"] path')[1]?.getAttribute('d') !== b, before);
    const box = (await page.locator('svg[role="img"]').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const tip = page.locator('.chart-tip');
    await tip.waitFor();
    const t1 = await tip.innerText();
    assert.match(t1, /\$\d/);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForFunction((t) => (document.querySelector('.chart-tip') as HTMLElement).innerText !== t, t1);
    await page.mouse.move(box.x - 50, box.y - 50);
    await tip.waitFor({ state: 'detached' });
    await page.locator('svg[role="img"]').focus();
    await tip.waitFor();
    const k1 = await tip.innerText();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((t) => (document.querySelector('.chart-tip') as HTMLElement).innerText !== t, k1);
    await page.getByRole('button', { name: 'View as table' }).click();
    assert.equal(await page.locator('.data-table').first().locator('tbody tr').count(), 24);
    await page.getByRole('button', { name: 'Hide table' }).click();
    await page.screenshot({ path: path.join(shots, 'bitcoin-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shots, 'bitcoin-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  // ============================== Wallet ==============================
  console.log('\nWallet & Value-for-Value');
  await step(page, 'connects the (fake) Alby extension, shows the balance, and reconnects after a reload', async () => {
    await page.getByRole('button', { name: 'Connect Alby extension' }).click();
    await page.getByText('50,000 sats').first().waitFor();
    await page.getByText('Test Node').waitFor();
    await page.reload();
    await page.locator('.chip', { hasText: '50,000 sats' }).waitFor();
  });

  await step(page, 'boost: previews the split (fee first), sends keysends with a boostagram, and logs them', async () => {
    await nav('Podcasts');
    await page.locator('.side-item.sub', { hasText: 'Sats & Stories' }).first().click();
    await page.locator('.episode', { hasText: 'Episode 2' }).locator('.ep-title').click();
    await page.getByRole('button', { name: 'Boost' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Custom amount in sats').fill('500');
    await dialog.getByLabel('Message (optional)').fill('Great show!');
    await dialog.getByLabel('Your name (optional)').fill('Sam');
    const preview = await dialog.locator('table').innerText();
    assert.match(preview, /App\s*fee\s*25 sats/);
    assert.match(preview, /Show\s*475 sats/);
    await dialog.getByRole('button', { name: 'Send boost' }).click();
    await dialog.getByText('Sent').first().waitFor();
    const sent = await keysends();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((k) => Number(k.amount)).sort((a, b) => a - b), [25, 475]);
    const show = sent.find((k) => Number(k.amount) === 475)!;
    assert.equal(show.destination, '02' + 'a'.repeat(64));
    const boost = JSON.parse(show.customRecords['7629169']!);
    assert.deepEqual([boost.action, boost.message, boost.sender_name, boost.value_msat, boost.value_msat_total, boost.episode], ['boost', 'Great show!', 'Sam', 475_000, 500_000, 'Episode 2: Lightning and Podcasts']);
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  await step(page, 'large payments require an explicit confirmation before anything is sent', async () => {
    const before = (await keysends()).length;
    await page.getByRole('button', { name: 'Boost' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Custom amount in sats').fill('2000');
    await dialog.getByRole('button', { name: 'Send boost' }).click();
    await dialog.getByText(/larger payment/).waitFor();
    assert.equal((await keysends()).length, before, 'nothing sent yet');
    await dialog.getByRole('button', { name: 'Back' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await keysends()).length, before);
  });

  await step(page, 'streaming sats: off by default; after turning it on, one minute of real listening pays the show', async () => {
    await nav('Bitcoin');
    const toggle = page.getByLabel('Stream sats while I listen');
    assert.equal(await toggle.isChecked(), false, 'off by default');
    await toggle.click(); // asks for confirmation rather than switching on silently
    assert.equal(await toggle.isChecked(), false, 'still off until confirmed');
    await page.getByRole('dialog').getByText(/10 sats per minute/).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
    await page.getByText(/Today: 0 sats of 1,000 sats/).waitFor();

    const before = (await keysends()).length;
    await nav('Podcasts');
    await page.locator('.episode', { hasText: 'Episode 3' }).locator('.ep-title').click();
    await page.getByRole('button', { name: 'Play', exact: true }).first().click();
    await playerRegion().waitFor();
    await playerRegion().getByLabel('Playback speed').selectOption('2.5');
    await playerRegion().getByText(/10\/min/).waitFor();
    // 60 s of media at 2.5x is ~24 s of wall time.
    await page.waitForFunction((n) => (window as unknown as { __keysends: unknown[] }).__keysends.length > n, before, { timeout: 60_000 });
    const sent = (await keysends()).slice(before);
    assert.equal(sent.length, 1, 'one recipient rounds to a non-zero share of 10 sats');
    assert.equal(Number(sent[0]!.amount), 10);
    const boost = JSON.parse(sent[0]!.customRecords['7629169']!);
    assert.deepEqual([boost.action, boost.value_msat, boost.episode, boost.message], ['stream', 10_000, 'Episode 3: The Long One', undefined]);
    await playerRegion().getByRole('button', { name: 'Pause' }).click();
  });

  await step(page, 'seeking does not count as listening (no payment for skipping ahead)', async () => {
    const before = (await keysends()).length;
    await playerRegion().getByLabel('Seek').press('Home');
    await playerRegion().getByLabel('Seek').press('End');
    await page.waitForTimeout(1500);
    assert.equal((await keysends()).length, before);
    await playerRegion().getByRole('button', { name: 'Close player' }).click();
  });

  await step(page, 'payment history lists every payment; the wallet page shows today’s streaming total', async () => {
    await nav('Bitcoin');
    await page.getByRole('heading', { name: 'Payments made from BitPodRSS' }).waitFor();
    const rows = await page.locator('section', { hasText: 'Payments made from BitPodRSS' }).locator('tbody tr').allInnerTexts();
    assert.ok(rows.some((r) => /boost/.test(r) && /475/.test(r)));
    assert.ok(rows.some((r) => /stream/.test(r) && /\b10\b/.test(r)));
    await page.getByText(/Today: 10 sats of 1,000 sats/).waitFor();
    await page.getByLabel('Stream sats while I listen').uncheck();
    await page.screenshot({ path: path.join(shots, 'wallet.png'), fullPage: true });
  });

  await step(page, 'send: pays a Lightning invoice only when it has a readable amount', async () => {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Lightning invoice or Lightning address/).fill('lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp');
    await dialog.getByText(/250,000 sats/).waitFor();
    await dialog.getByLabel(/Lightning invoice or Lightning address/).fill('lnbc-not-really-an-invoice');
    await dialog.getByText(/no fixed amount|could not be read/).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // ============================== Settings & identity ==============================
  console.log('\nSettings & identity');
  await step(page, 'theme switch, OPML export and import (with a failing feed reported)', async () => {
    await nav('Settings');
    await page.getByRole('button', { name: 'Dark' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
    await page.screenshot({ path: path.join(shots, 'settings-dark.png'), fullPage: true });
    await page.getByRole('button', { name: 'Match system' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export OPML' }).click()]);
    const opml = fs.readFileSync((await dl.path())!, 'utf8');
    for (const f of ['wire-one.xml', 'wire-two.xml', 'podcast.xml', 'evil.xml']) assert.ok(opml.includes(f), `exported ${f}`);
    assert.ok(opml.includes('text="Wires"'), 'categories exported as folders');
    await page.getByRole('button', { name: 'Import OPML' }).click();
    const file = `<?xml version="1.0"?><opml version="2.0"><body><outline text="Mixed"><outline type="rss" text="A" xmlUrl="${fixtures.base}/wire-one.xml"/><outline type="rss" text="B" xmlUrl="${fixtures.base}/podcast.xml"/><outline type="rss" text="C" xmlUrl="${fixtures.base}/missing.xml"/></outline></body></opml>`;
    await page.getByRole('dialog').locator('input[type="file"]').setInputFiles({ name: 'subs.opml', mimeType: 'text/xml', buffer: Buffer.from(file) });
    await page.getByRole('dialog').getByText(/Found 3 feeds/).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: /Import 3 feeds/ }).click();
    await page.getByRole('dialog').getByText(/Added 0, already subscribed 2, failed 1/).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  });

  await step(page, 'Nostr identity is optional: connect a signer, see the identity, share an episode, disconnect', async () => {
    assert.equal(await page.locator('.chip', { hasText: 'Nostr' }).count(), 0, 'nothing shown before connecting');
    await page.getByRole('button', { name: 'Connect with Nostr extension' }).click();
    await page.getByText('Signer connected').waitFor();
    assert.match(await page.locator('section[aria-labelledby="s-identity"]').innerText(), /npub180cvv07…/);
    await page.locator('.topbar .chip', { hasText: 'Nostr' }).waitFor();
    await nav('Podcasts');
    await page.locator('.side-item.sub', { hasText: 'Sats & Stories' }).first().click();
    await page.locator('.episode', { hasText: 'Episode 2' }).locator('.ep-title').click();
    await page.getByRole('button', { name: 'Share on Nostr' }).click();
    await page.getByText(/None of the Nostr relays accepted|Shared to/).waitFor({ timeout: 20_000 });
    await nav('Settings');
    await page.locator('section[aria-labelledby="s-identity"]').getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('button', { name: 'Connect with Nostr extension' }).waitFor();
    assert.equal(await page.locator('.topbar .chip', { hasText: 'Nostr' }).count(), 0);
  });

  await step(page, 'a private key (nsec) is refused when pasted as an identity', async () => {
    await page.getByLabel('Your npub').fill('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5');
    await page.getByRole('button', { name: 'Use npub' }).click();
    await page.getByText(/public key/).first().waitFor();
    assert.equal(await page.locator('section[aria-labelledby="s-identity"]').getByText('Read-only (npub)').count(), 0);
  });

  // ============================== Mobile ==============================
  console.log('\nMobile layout (390x844)');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [label, name] of [['Reader', 'reader'], ['Podcasts', 'podcasts'], ['Bitcoin', 'bitcoin'], ['Settings', 'settings']] as const) {
    await step(page, `${label} fits the screen without horizontal scrolling`, async () => {
      await nav(label);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth }));
      assert.ok(overflow.doc <= 1 && overflow.body <= 1, `horizontal overflow: ${JSON.stringify(overflow)}`);
      await page.screenshot({ path: path.join(shots, `mobile-${name}.png`) });
    });
  }
  await page.setViewportSize({ width: 1360, height: 860 });

  await browser.close();
  await fixtures.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  if (pageErrors.length) console.log(`\nBrowser errors:\n  ${pageErrors.join('\n  ')}`);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? '' : ' ✔'}`);
  if (failed.length || pageErrors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
