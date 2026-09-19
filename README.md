# iK(no)w Ball

A live sports group-chat copilot. Browserbase polls current X/Reddit search pages, a Node server keeps a rolling in-memory window, Gemini creates tone-matched reactions, and a Chrome side panel inserts the selected message into Discord Web without sending it.

## What is implemented

- Browserbase + Playwright collector for X and Reddit search pages
- Configurable 10–15 second polling (12 seconds by default)
- Deduplicated 100-post in-memory sliding window
- Batches of 10 posts, with up to 3 Gemini calls running concurrently
- Minimum 20 seconds between generation cycles
- Cached three-suggestion deck for a fast extension UI
- Manifest V3 Chrome side panel
- Discord Web content script with clipboard fallback
- Fully local demo mode when API keys are missing

## Architecture

1. Browserbase reloads narrow X and/or Reddit searches every 12 seconds.
2. Node deduplicates results into the rolling buffer.
3. Once at least five new posts exist, Node selects at most 30 recent posts.
4. The posts are divided into groups of 10 and processed with bounded parallelism.
5. Node locally selects the best safe, funny, and spicy result and caches the deck.
6. The extension reads the cache every three seconds.
7. Clicking a suggestion sends it to the Discord content script for local insertion.

The click path never waits for Browserbase or Gemini.

## Run without API keys

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Run `npm run dev`.

If either external key is missing, that component uses a deterministic demo implementation. This lets the whole extension flow be tested immediately.

## Enable Browserbase and Gemini

Add these values to `.env`:

- `BROWSERBASE_API_KEY`
- `GEMINI_API_KEY`

The default model is `gemini-3.8-flash` and can be changed with `GEMINI_MODEL`.

When a real Browserbase session starts, the API and extension return an `Open Browserbase login` link. Use that live browser view to sign into X manually. Never put an X password in `.env` or commit it.

X and Reddit change their markup regularly. The current selectors are isolated in `server/src/collectors/browserbaseCollector.ts` so they are quick to repair during the hackathon.

## Load the Chrome extension

1. Start the Node server on port 3000.
2. Open `chrome://extensions` in Chrome.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `extension` folder in this repository.
6. Open Discord Web and enter a channel.
7. Click the extension icon to open its side panel.
8. Enter the game, optional tone examples, and click Start watching.

The extension fills the Discord composer but never sends a message automatically.

## API

- `GET /health`
- `POST /api/session/start`
- `GET /api/session/status`
- `POST /api/session/stop`
- `GET /api/suggestions`
- `POST /api/suggestions/refresh`

Example session input contains a `game`, a `sources` array containing `x` and/or `reddit`, and an optional `toneExamples` string array.

## Development checks

- `npm test`
- `npm run typecheck`
- `npm run build`

## Scope intentionally deferred

- Databases and multi-user accounts
- Native Discord or iMessage integration
- Automatic message sending
- Elasticsearch
- Production-grade X/Reddit scraping guarantees
- Chrome Web Store publishing
