# iK(no)w Ball

A live sports group-chat copilot. Browserbase polls X/Reddit search pages, a Node server keeps a rolling in-memory window, and Gemini creates tone-matched reactions in a Chrome side panel that can insert them into Discord. A normal web page remains available as an optional client.

## What is implemented

- Browserbase + Playwright collector for X and Reddit search pages
- Keyless Google News RSS collector for real public evidence
- Configurable 10–15 second polling (12 seconds by default)
- Deduplicated 100-post in-memory sliding window
- Batches of 10 posts, with up to 3 Gemini calls running concurrently
- Minimum 20 seconds between generation cycles
- Cached three-suggestion deck for a fast side-panel UI
- Manifest V3 Chrome side panel as the primary client
- Discord Web content script with clipboard fallback
- Optional browser UI at `http://localhost:3000`
- Historical search mode when the query includes a year
- Source-evidence cards showing what Browserbase actually collected

## Architecture

1. Browserbase reloads narrow X and/or Reddit searches every 12 seconds.
2. Node deduplicates results into the rolling buffer.
3. Once at least five new posts exist, Node selects at most 30 recent posts.
4. The posts are divided into groups of 10 and processed with bounded parallelism.
5. Node locally selects the best safe, funny, and spicy result and caches the deck.
6. The side panel reads the cache every three seconds.
7. Reading Discord history updates the active reply context and refreshes suggestions.
8. Clicking a suggestion inserts it into Discord or copies it to the clipboard.

The click path never waits for Browserbase or Gemini.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.

The default Public news source works without an API key and uses real Google News RSS results. Add these values to enable X/Reddit and Gemini:

- `BROWSERBASE_API_KEY`
- `GEMINI_API_KEY`

4. Run `npm run dev`.

The app never replaces source evidence with demo data. If Gemini rejects its credential, it creates short local copy using only the real evidence displayed on the page and labels that mode clearly.

The default model is `gemini-3.8-flash` and can be changed with `GEMINI_MODEL`.

When a real Browserbase session starts, the API and extension return an `Open Browserbase login` link. Use that live browser view to sign into X manually. Never put an X password in `.env` or commit it.

X and Reddit change their markup regularly. The current selectors are isolated in `server/src/collectors/browserbaseCollector.ts` so they are quick to repair during the hackathon.

## Load the Chrome extension

1. Start the Node server on port 3000 with `npm run dev`.
2. Open `chrome://extensions` in Chrome.
3. Enable Developer mode, click Load unpacked, and select the `extension` folder.
4. Open Discord Web and enter a channel.
5. Click the iK(no)w Ball extension icon to open the side panel.
6. Enter the game, choose X, Reddit, or Public News, add optional tone examples, and click Start watching.
7. For reply context, either type a message manually or click **Read last 10 messages** while the target Discord channel is open.
8. Review the evidence cards, then click a suggestion to insert it into Discord. The extension never sends a message automatically.

The side panel includes the full setup, live status, source evidence, refresh and stop controls, and the same historical and thinking-mode behavior as the optional web client.

## Optional: open the local web UI

Open `http://localhost:3000` after starting the server. It uses the same API and remains useful for debugging the source collector without loading the extension.

## Run the recording demo on another laptop

Use this path when the other laptop can load unpacked Chrome extensions. Run the
Node server and Chrome extension on that same laptop so the extension can reach
`http://localhost:3000` without any networking changes.

### 1. Clone and install

The other laptop needs Git, Chrome, and Node.js 20 or newer.

```bash
git clone https://github.com/yiyan023/hack-the-north-2026.git
cd hack-the-north-2026
npm install
cp .env.example .env
```

### 2. Configure `.env`

Copy these secrets to the other laptop through a private channel. Do not commit
the `.env` file:

- `BROWSERBASE_API_KEY`: a key for the Browserbase project that owns the context.
- `BROWSERBASE_CONTEXT_ID`: `fd285515-74ba-4432-8d63-b9e9d70dc21d` for the
  currently authenticated X context.
- `GEMINI_API_KEY`: a valid key created in Google AI Studio or supplied through
  the hackathon. The key used during the September 19 test returned
  `API_KEY_INVALID`, so generate a fresh key for the recording.
- `GEMINI_MODEL=gemini-3.8-flash`.

The Browserbase context is stored in Browserbase, not on this Mac. Reusing its
context ID and a key from the same Browserbase project should preserve the X
login on the other laptop. Normal collection sessions use the context read-only
so they cannot overwrite the saved login.

### 3. Start and verify the server

```bash
npm run dev
```

Leave that terminal open. Visit `http://localhost:3000/health`; it should show
`{"ok":true}`. For the lowest-risk recording, first test the normal web UI at
`http://localhost:3000` with X selected and Fast mode enabled.

### 4. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension` folder.
5. Pin **iK(no)w Ball** from Chrome's extensions menu.
6. Open `https://discord.com/app` and enter the channel used for the demo.
7. Click the iK(no)w Ball icon to open its side panel.

### 5. Recording flow

1. Enter a narrow current-game query, such as both team names plus the
   competition. Broad terms like `football` work but produce less specific copy.
2. Optionally paste the Discord message being answered into **Message to reply
   to** and add one or two tone examples.
3. Select X and **Fast · 2 posts per reply**.
4. Click **Start watching** and wait for three suggestions.
5. Click one suggestion. It should fill the active Discord composer without
   sending it; press Enter manually when ready.

Fast mode still monitors X every 12 seconds so the context stays current. It
limits each Gemini request to the latest two posts; it does not stop monitoring
after two posts.

### Recording troubleshooting

- **No posts:** open the Browserbase debug link and confirm X search results are
  visible. If X asks for login, complete one login in a `persist: true` session,
  close that session, wait several seconds, and restart the demo.
- **Local mode / Gemini warning:** the key is missing or invalid. Replace
  `GEMINI_API_KEY`, then restart `npm run dev` and start a new watching session.
- **Suggestion copies instead of inserting:** keep Discord Web as the active tab,
  enter a text channel, and click the suggestion again.
- **Extension changed:** return to `chrome://extensions` and click the reload icon
  on the iK(no)w Ball card.
- **Port 3000 is occupied:** stop the older Node process before running the demo;
  the extension intentionally expects port 3000.

## API

- `GET /health`
- `POST /api/session/start`
- `GET /api/session/status`
- `GET /api/posts?limit=12`
- `POST /api/session/stop`
- `POST /api/session/context`
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
