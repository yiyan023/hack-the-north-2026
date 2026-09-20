# iK(no)w Ball

A live sports group-chat copilot. Browserbase polls X search pages, a Node server keeps an in-memory work queue plus a rolling context window, and Gemini creates tone-matched reactions in a Chrome side panel that can insert them into Discord. A normal web page remains available as an optional client.

## What is implemented

- One prewarmed Browserbase + Playwright session for authenticated X searches
- Keyless Google News RSS collector for real public evidence
- Configurable 10–15 second polling (12 seconds by default)
- Deduplicated pending queue with explicit pending, in-flight, and processed states
- Bounded recent-context window for conversational continuity
- Batches of 10 posts, with up to 3 Gemini calls running concurrently
- Minimum 20 seconds between generation cycles
- Cached three-suggestion deck for a fast side-panel UI
- Manifest V3 Chrome side panel as the primary client
- Discord Web content script with clipboard fallback
- Optional browser UI at `http://localhost:3000`
- Historical search mode when the query includes a year
- Source-evidence cards showing what Browserbase actually collected

## Architecture

1. Server startup creates one Browserbase session, connects Playwright, and opens X home before the user starts watching a game.
2. Starting or switching games redirects the same X tab to the new search URL. It does not create another Browserbase session.
3. Browserbase extracts the already-rendered first result page, then reloads the active search every 12 seconds.
4. Node removes repeated post IDs and normalized duplicate text, then adds new evidence to the pending queue.
5. A generation cycle claims the configured number of pending posts and marks them in flight.
6. Gemini receives those new posts plus a small recent-context window and returns safe, funny, and spicy suggestions.
7. Deep-mode batches may run concurrently; each post is claimed only once.
8. Successful posts leave the queue and enter recent context. Failed posts return to pending for a later retry.
9. Posts collected while Gemini is running remain pending and are processed automatically in a follow-up cycle.
10. Node caches the latest suggestion deck while the side panel checks for updates every three seconds.
11. Reading Discord history updates the active reply context and can regenerate against recent context without treating old posts as new.
12. Clicking a suggestion inserts it into Discord or copies it to the clipboard.

**Stop watching** pauses polling but deliberately keeps the prewarmed browser alive. The Browserbase session closes during graceful server shutdown or at Browserbase's six-hour maximum (`BROWSERBASE_SESSION_TIMEOUT_SEC=21600`).

The click path never waits for Browserbase or Gemini.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.

The default Public news source works without an API key and uses real Google News RSS results. Add these values to enable X and Gemini:

- `BROWSERBASE_API_KEY`
- `BROWSERBASE_CONTEXT_ID`
- `BROWSERBASE_REGION=us-east-1` chooses the closest currently supported Browserbase region for Toronto.
- `BROWSERBASE_SESSION_TIMEOUT_SEC=21600` uses Browserbase's six-hour maximum session lifetime.
- `GEMINI_API_KEY`
- `ENABLE_TEST_FEED=true` to enable the local synthetic feed for end-to-end testing.
- `SENTIMENT_REFRESH_INTERVAL_MS=60000` controls how often aggregate sentiment is checked.
- `SENTIMENT_CHANGE_THRESHOLD=0.35` controls how large a sentiment shift must be to refresh.
- `GEMINI_CONTEXT_POSTS=3` controls how many successfully processed posts are included as background context.

4. Run `npm run dev`.

The app never replaces source evidence with demo data. If Gemini rejects its credential, it creates short local copy using only the real evidence displayed on the page and labels that mode clearly.

The default model is `gemini-3.5-flash-lite` and can be changed with `GEMINI_MODEL`.

For an end-to-end test without a live game, set `ENABLE_TEST_FEED=true` in your
local `.env`, restart the server, select **Synthetic test feed**, and start
watching. Five realistic setup posts load immediately, followed by staged
match updates including a goal, stoppage time, and full time. The normal
polling, generation, evidence, and Discord insertion paths are exercised. The
synthetic source must be selected by itself and is disabled by default.

For a new X context, create one persistent Browserbase login session manually
with the curl setup below, open its Browserbase session URL, and sign into X
inside the remote Browserbase browser. Signing into X in your normal Chrome
window does not change the Browserbase context.
Close that setup session after the login is saved. The app's normal collector
sessions use the same context read-only with `persist: false`. Never put an X
password in `.env` or commit it.

From the repository root, load your private `.env` values into the current
terminal and create the setup session:

```bash
set -a; source .env; set +a
curl --request POST \
  --url https://api.browserbase.com/v1/sessions \
  --header "Content-Type: application/json" \
  --header "X-BB-API-Key: $BROWSERBASE_API_KEY" \
  --data "{\"browserSettings\":{\"context\":{\"id\":\"$BROWSERBASE_CONTEXT_ID\",\"persist\":true}},\"keepAlive\":true,\"timeout\":600}"
```

Copy the returned session `id`, open
`https://browserbase.com/sessions/<SESSION_ID>`, and sign into X inside the
displayed Browserbase session. Close the
setup session after the context has saved the login, then run `npm run dev` and
use the extension normally.

X changes its markup regularly. The current selectors are isolated in `server/src/collectors/browserbaseCollector.ts` so they are quick to repair during the hackathon.

## Load the Chrome extension

1. Start the Node server on port 3000 with `npm run dev`.
2. Open `chrome://extensions` in Chrome.
3. Enable Developer mode, click Load unpacked, and select the `extension` folder.
4. Open Discord Web and enter a channel.
5. Click the iK(no)w Ball extension icon to open the side panel.
6. Enter the game or sports topic manually, then choose X, Public News, or Synthetic test feed, add optional tone examples, and click Start watching.
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
- `BROWSERBASE_CONTEXT_ID`: your own Browserbase context ID. Provide it privately
  through `.env`; do not commit it. Use the one-time persistent curl setup to
  save the manual X login before starting the app.
- `GEMINI_API_KEY`: a valid key created in Google AI Studio or supplied through
  the hackathon. The key used during the September 19 test returned
  `API_KEY_INVALID`, so generate a fresh key for the recording.
- `GEMINI_MODEL=gemini-3.5-flash-lite`.

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
claims up to two unprocessed posts for each Gemini request and includes a small
processed context window; it does not stop monitoring after two posts.

### Recording troubleshooting

- **No posts:** open the Browserbase session link. If X asks for login, complete
  the manual login there and leave the session running until the next poll shows
  X results. The context uses `persist: true`, so later sessions reuse that login.
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

Example session input contains a `game`, a `sources` array containing `x`, `news`, or `test`, and an optional `toneExamples` string array.

## Development checks

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:e2e:latency` (requires working Browserbase and Gemini credentials)

## Scope intentionally deferred

- Databases and multi-user accounts
- Native Discord or iMessage integration
- Automatic message sending
- Elasticsearch
- Production-grade X scraping guarantees
- Chrome Web Store publishing
