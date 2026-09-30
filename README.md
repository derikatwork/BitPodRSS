# BitPodRSS

A local-first **RSS reader** and **podcast player** with **Lightning (Alby) payments**, a **Bitcoin price chart**, **on-device transcription** and an optional **Nostr identity**.

Your subscriptions, reading state and playback progress live in your own browser. A small Node server, running on your machine, does the things a browser can't: fetching feeds (no CORS limits), extracting article text, and transcribing audio.

## Quick install (Debian / Ubuntu)

```bash
git clone https://github.com/derikatwork/BitPodRSS.git
cd BitPodRSS
./scripts/install.sh     # installs git/curl/ffmpeg and Node 22 if missing, then npm install + build
npm run serve            # open http://localhost:8787
```

Run `./scripts/install.sh --help` for options. Other systems, or prefer doing it by hand? See the [full walkthrough](#installation-and-setup-walkthrough).

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

## Installation and setup walkthrough

**Debian / Ubuntu shortcut:** steps 1–2 below are automated by `scripts/install.sh`. It installs only what's missing (git, curl, ffmpeg), installs Node 22 via nvm if your Node is absent or too old, then runs `npm install` and the build. Options: `--no-ffmpeg`, `--dir PATH`, `--no-build`.

```bash
git clone https://github.com/derikatwork/BitPodRSS.git && cd BitPodRSS && ./scripts/install.sh
npm run serve
```

Then continue from step 3. The manual steps follow if you prefer them or aren't on Debian.

### 1. Install the prerequisites

You need **Node.js 22.19 or newer**, **git**, and a modern browser (Chrome, Edge, Firefox or Safari). **ffmpeg** is optional (only for local transcription).

**Debian / Ubuntu** (Debian's packaged `nodejs` is too old, 18 on bookworm, so use nvm or NodeSource):

```bash
sudo apt update && sudo apt install -y git curl ffmpeg
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
# open a new terminal, then:
nvm install 22
node --version        # must print v22.19 or higher
```

**macOS:** `brew install node git ffmpeg`. **Windows:** install Node 22 from nodejs.org and ffmpeg from ffmpeg.org (or use WSL with the Debian steps).

### 2. Get the code and start it

```bash
git clone https://github.com/derikatwork/BitPodRSS.git
cd BitPodRSS
npm install
npm run serve          # builds the app, then serves it
```

Open **http://localhost:8787**. Leave the terminal running; press `Ctrl+C` to stop. Next time, `npm run serve` is all you need. For development with hot reload use `npm run dev` (UI on :5173, API on :8787).

### 3. Add your subscriptions

- **Reader** → **+** → paste a feed address or just a website address (the feed is found automatically). Or use the upload icon to **import an OPML** file exported from another reader.
- **Podcasts** → **+** → paste the podcast's RSS feed URL (or import OPML; podcasts and articles are sorted automatically).
- Organise as you go: drag feeds onto **Categories** in the Reader, and podcasts onto **Groups**. Use the **Queue** button on any episode to build an *Up next* list.

### 4. Try read-aloud

Open an article and press **Listen**. In **Settings → Read aloud** pick a voice (*Preview* lets you hear it) and tick *Prefer on-device voices* if you don't want text sent to a browser vendor's cloud. Natural/Neural/Enhanced voices sound best; on Linux you may need Edge or extra voices (see Known limitations).

### 5. Connect a Lightning wallet (optional)

Go to **Bitcoin → Lightning wallet** and pick one:

- **Alby extension:** install the [Alby extension](https://getalby.com), create or import your wallet in it, reload BitPodRSS, then press **Connect Alby extension** and approve the prompt.
- **Nostr Wallet Connect** (Alby Hub or an Alby account): in Alby Hub open *Connections → Add connection*, allow **pay invoices**, **pay keysend** (podcast payments need this) and **read balance**, and **set a monthly budget**. Copy the `nostr+walletconnect://…` string, paste it into *Nostr Wallet Connect* and press **Connect**.

Your balance appears once connected. To support a show, open an episode and press **Boost**. To pay automatically while you listen, turn on **Stream sats while I listen** on the same page; it explains exactly what it will spend and is capped per day. See *Payments and safety* below.

### 6. Turn on local transcription (optional)

Install **ffmpeg** (step 1) and restart the server, then check **Settings → Local transcription**: both *ffmpeg found* and *Speech engine ready* should show green. On an episode's **Transcript** tab press **Transcribe**; the Whisper model (40–250 MB) downloads on the first run, then it works offline. You can leave the page while it runs. If *Speech engine unavailable* shows, run `npm install @huggingface/transformers` and restart.

### 7. Connect a Nostr identity (optional)

**Settings → Nostr identity**: connect with a NIP-07 extension (Alby works) or paste your **npub**. Your name is then attached to boosts and you can share episodes as notes. Skip it and everything still works.

### Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` complains about the Node version | `node --version` must be ≥ 22.19 (see step 1) |
| "Could not reach the BitPodRSS server" | The terminal running `npm run serve` was closed; start it again |
| Adding a feed says "private or reserved address" | The feed is on your LAN. Start with `ALLOW_PRIVATE_NETWORK=1 npm run serve` |
| Page says the Host is not allowed | You opened it by a name other than `localhost`; set `ALLOWED_HOSTS=yourname` |
| "ffmpeg not found" / "Speech engine unavailable" | Step 6 |
| Transcription fails downloading the model | The server needs internet access to huggingface.co once |
| Alby extension "not detected" | Reload the page after installing the extension |
| No or robotic read-aloud voices | Browser/OS limitation; try Edge or install better voices |
| Lost subscriptions after clearing browser data | Data lives in the browser; export OPML regularly |

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

The end-to-end suite (`e2e/`) starts fixture feed servers, including duplicate stories, a Podcasting 2.0 show with a value block, a real playable WAV and a hostile feed, and exercises the whole UI with a fake Alby/Nostr extension. It **verifies, among other things, that one real minute of listening streams exactly one payment and that seeking streams none**. Fetch a browser once with `npx playwright-core install chromium --with-deps` (Debian/Ubuntu), or set `CHROMIUM_PATH` to an existing Chrome/Chromium.

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
