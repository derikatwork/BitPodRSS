# BitPodRSS

A local-first **RSS reader** and **podcast player** with **Lightning (Alby) payments**, a **Bitcoin price chart**, **on-device transcription** and an optional **Nostr identity**.

Your subscriptions, reading state and playback progress live in your own browser. A small Node server, running on your machine, does the things a browser can't: fetching feeds (no CORS limits), extracting article text, and transcribing audio.

## Features

### RSS reader
- **Import feeds** by feed URL, by website address (the feed is auto-discovered), or by **OPML** file. Export OPML any time. Supports RSS 2.0, RSS 1.0, Atom and JSON Feed.
- **Titles and summaries** for every article. One click loads the full article and writes an **extractive summary** (runs locally, no AI service).
- **Read aloud**: turns the article into clean speech text (URLs and markup removed, `$1.5B` → "1.5 billion dollars"), picks the most natural voice your device offers, and reads sentence by sentence with pause, skip and speed. Prefers on-device voices if you ask it to.
- **Duplicate detection across feeds**: matches the same URL (ignoring tracking parameters) and near-identical headlines/summaries. Suspected duplicates are **highlighted** with *Duplicate / Likely duplicate / Possible duplicate*, listed in their own view, can be collapsed ("Hide duplicates"), and any false positive can be dismissed with **Not a duplicate**.
- **Categories**: sort feeds into categories by drag and drop or from the feed's settings.

### Podcast catcher
- **Import a podcast from its RSS feed.** Handles **Podcasting 1.0** (RSS + iTunes tags) and **Podcasting 2.0**: `podcast:transcript`, `podcast:chapters`, `podcast:person`, `podcast:soundbite`, `podcast:funding`, `podcast:value`, season/episode, alternate enclosures.
- **Queues** (as many as you like, reorderable, auto-advance, finished episodes leave the queue) and **groups** (a show can be in several).
- Resume where you left off, playback speed, chapters, OS media-key support.
- **Transcripts**: the publisher's transcript is loaded and **follows playback** (click a line to jump there). If there isn't one, **transcribe locally** with Whisper. Export VTT, SRT or TXT.
- **Value-for-Value**: send a **boost** with a message, or opt in to **stream sats** for every minute you listen. See *Payments and safety* below.

### Bitcoin and Lightning
- Connect **Alby** with the browser extension (WebLN) or **Nostr Wallet Connect** (Alby Hub / Alby account). Send to an invoice or Lightning address, receive, see your balance.
- **Price visual**: current price plus **1 week, 1 month, 1 year and year-to-date** change, with an interactive chart (hover or arrow keys), light and dark themes, and a table view of the same data. USD, EUR, GBP, CAD, AUD, CHF, JPY.
- **Nostr identity (optional)**: connect a NIP-07 signer or paste an npub. It is used for boosts and for sharing an episode as a note. Nothing requires it.

## Quick start

Requires **Node 20.11+**.

```bash
npm install
npm run serve          # builds the app and serves everything on http://localhost:8787
```

For development with hot reload (API on :8787, UI on :5173):

```bash
npm run dev
```

### Optional: local transcription

Transcription runs on the machine that runs the server and needs two things:

1. **ffmpeg** on your `PATH` (`brew install ffmpeg`, `sudo apt install ffmpeg`, …) or set `FFMPEG_PATH`.
2. The optional package **`@huggingface/transformers`**, installed by `npm install` as an *optional dependency* (the project's `.npmrc` skips the GPU-only downloads that otherwise fail on restricted networks; the CPU runtime is bundled). If it isn't installed the rest of the app works normally.

The Whisper model (40–250 MB depending on the size you pick) is downloaded once on first use into `./data/models`, after which transcription works offline. The app tells you in **Settings → Local transcription** whether both pieces are available. Everything else works without them.

### Connecting Alby

- **Extension**: install the [Alby extension](https://getalby.com), then *Bitcoin → Connect Alby extension*.
- **Nostr Wallet Connect**: in Alby Hub open *Connections → Add connection*, allow **pay invoices**, **pay keysend** (needed for podcast payments) and **read balance**, **set a monthly budget**, then paste the `nostr+walletconnect://…` string in *Bitcoin → Nostr Wallet Connect*.

## Payments and safety

This app can move real money, so it is deliberately conservative:

- **Nothing is ever sent automatically** unless you turn on *Stream sats while I listen*, which asks for confirmation and shows exactly what it will spend.
- Streaming has a **daily limit** (default 1,000 sats), counts only **time actually listened** (pausing or seeking never pays), and **turns itself off after two failed payments in a row**.
- Payments of at least a threshold you set (default 1,000 sats) need a **second confirmation**.
- Lightning-address payments **verify the invoice amount** before paying, so a misbehaving server can't charge more than you asked.
- Every payment attempt, successful or not, is listed in a **history** on the Bitcoin page.
- The Nostr Wallet Connect string can spend from your wallet, so it is stored **only in your browser**, never on the server. **Give it a budget in your wallet**; that limit is the real safety net, and this app's limits are a second layer.
- A private key (`nsec`) pasted as an identity is rejected; only public keys are accepted.

How value splits work: fee recipients (`fee="true"`) take their percentage first; the rest is divided by `split` shares using exact integer sats (largest-remainder), and recipients whose share rounds to zero are skipped.

## Privacy and security

- **Your data stays in your browser** (IndexedDB and localStorage). The server keeps no account, no subscriptions and no history; it stores only downloaded Whisper models and finished transcripts in `./data`.
- **The server is for you, not the internet.** It listens on `127.0.0.1`, rejects requests for unknown `Host` headers (DNS-rebinding protection) and cross-origin requests, and **refuses to fetch private, loopback or link-local addresses** (checked at connect time, so DNS tricks and redirects can't sneak past). If you keep feeds on your own network, set `ALLOW_PRIVATE_NETWORK=1`.
- Feed and article HTML is **sanitised** before display (scripts, frames, forms, styles and event handlers removed) and the served app has a strict **Content-Security-Policy**. This is exercised in the end-to-end tests with a deliberately hostile feed.
- Audio is decoded by ffmpeg restricted to the `pipe` protocol, so a crafted playlist can't make it read local files or other URLs.
- Third-party requests your browser makes: Lightning-address servers (when you pay one), Nostr relays (only if you connect an identity), and the speech vendor's cloud only if you pick a voice labelled *cloud*. The Bitcoin price is fetched by the server from CoinGecko (falling back to Coinbase).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Bind address. Only change this if you understand the exposure. |
| `ALLOWED_HOSTS` | *(none)* | Extra `Host` names to accept, comma separated (needed when using a LAN name) |
| `DATA_DIR` | `./data` | Whisper models, transcript cache, temp audio |
| `ALLOW_PRIVATE_NETWORK` | `0` | `1` lets the server fetch feeds from private/LAN addresses |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |
| `MAX_AUDIO_MB` | `1024` | Largest episode the transcriber will download |

## Development

```bash
npm run typecheck   # client, server and e2e
npm test            # unit and integration tests (vitest)
npm run e2e         # builds, then drives the real app in Chromium against fixture feeds
npm run check       # typecheck + tests + build
```

The end-to-end suite (`e2e/`) starts fixture feed servers, including duplicate stories, a Podcasting 2.0 show with a value block, a real playable WAV and a hostile feed, and exercises the whole UI with a fake Alby/Nostr extension. It **verifies, among other things, that one real minute of listening streams exactly one payment and that seeking streams none**. Set `CHROMIUM_PATH` if Playwright's browser isn't installed where it expects.

### Layout

```
shared/    pure, dependency-light logic used by both sides (duplicate detection, summariser,
           value splits, price maths, transcript parsing, OPML, speech text prep)
server/    Express API: SSRF-safe fetching, feed parser, article extraction, BTC price,
           transcription pipeline (ffmpeg + sliding Whisper windows)
src/       React client: Dexie database, stores, Reader / Podcasts / Bitcoin / Settings
e2e/       Playwright end-to-end suite and fixtures
```

## Known limitations

- **Read-aloud quality depends on your device's voices.** Chrome/Edge (Natural/Online voices), Safari (Enhanced/Premium) and recent Android/iOS sound very good; some Linux setups only have robotic voices. The voice picker ranks them and labels cloud voices.
- Local transcription is **CPU-based and slower than real time on small machines** (use the *Tiny* model for speed, *Small* for accuracy). Progress and partial text appear as it goes, and you can leave the page while it runs.
- There is **no cloud sync**: use OPML export/import to move subscriptions between devices.
- Episodes are **streamed, not downloaded** for offline listening.
- Podcasting 2.0 support covers the tags listed above; live items, `podcast:valueTimeSplit` and `podcast:podroll` are not interpreted yet.

## License

MIT
