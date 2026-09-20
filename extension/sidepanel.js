const API_BASE = "http://localhost:3000";
const elements = {
  game: document.querySelector("#game"),
  replyTo: document.querySelector("#reply-to"),
  manualReply: document.querySelector("#manual-reply"),
  readReply: document.querySelector("#read-reply"),
  tone: document.querySelector("#tone"),
  thinkingMode: document.querySelector("#thinking-mode"),
  sourceX: document.querySelector("#source-x"),
  // Reddit support disabled.
  sourceNews: document.querySelector("#source-news"),
  sourceTest: document.querySelector("#source-test"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  refresh: document.querySelector("#refresh"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#status-dot"),
  updated: document.querySelector("#updated"),
  sessionMeta: document.querySelector("#session-meta"),
  sourceStatus: document.querySelector("#source-status"),
  moment: document.querySelector("#moment"),
  suggestions: document.querySelector("#suggestions"),
  posts: document.querySelector("#posts"),
  evidenceMeta: document.querySelector("#evidence-meta"),
  notice: document.querySelector("#notice"),
  debugLink: document.querySelector("#debug-link"),
};

let generatedAt;
let thinkingMode;
let pollTimer;

chrome.storage.local.get(["game", "replyTo", "tone", "thinkingMode", "sourceX", "sourceNews", "sourceTest"], (saved) => {
  if (saved.thinkingMode) elements.thinkingMode.value = saved.thinkingMode;
  if (typeof saved.sourceX === "boolean") elements.sourceX.checked = saved.sourceX;
  if (typeof saved.sourceNews === "boolean") elements.sourceNews.checked = saved.sourceNews;
  if (typeof saved.sourceTest === "boolean") elements.sourceTest.checked = saved.sourceTest;
  chrome.storage.local.remove(["game", "replyTo", "tone"]);
});

elements.thinkingMode.addEventListener("change", () => {
  chrome.storage.local.set({ thinkingMode: elements.thinkingMode.value });
});
elements.manualReply.addEventListener("click", () => {
  elements.replyTo.value = "";
  elements.replyTo.disabled = false;
  elements.replyTo.focus();
  elements.manualReply.classList.add("active");
  elements.readReply.classList.remove("active");
});
elements.readReply.addEventListener("click", readRecentMessages);

elements.start.addEventListener("click", startSession);
elements.stop.addEventListener("click", stopSession);
elements.refresh.addEventListener("click", () => refreshSuggestions(true));

async function startSession() {
  const game = elements.game.value.trim();
  const sources = [
    elements.sourceX.checked ? "x" : null,
    elements.sourceNews.checked ? "news" : null,
    elements.sourceTest.checked ? "test" : null,
  ].filter(Boolean);

  if (!game || sources.length === 0) {
    showNotice("Enter a game and select at least one source.");
    return;
  }

  elements.start.disabled = true;
  showNotice("");
  setStatus("Starting source collector…", false);
  elements.suggestions.replaceChildren(empty("Collecting evidence and preparing suggestions…"));
  elements.posts.replaceChildren(empty("Waiting for the first real-data pull…"));

  try {
    const toneExamples = elements.tone.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const selectedThinkingMode = elements.thinkingMode.value;
    const replyTo = elements.replyTo.value.trim();
    const response = await fetch(`${API_BASE}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game, sources, toneExamples, replyTo, thinkingMode: selectedThinkingMode }),
    });
    const payload = await readJson(response);

    chrome.storage.local.set({
      game,
      replyTo,
      tone: elements.tone.value,
      thinkingMode: selectedThinkingMode,
      sourceX: elements.sourceX.checked,
      sourceNews: elements.sourceNews.checked,
      sourceTest: elements.sourceTest.checked,
    });
    elements.stop.disabled = false;
    elements.refresh.disabled = false;
    setStatus(payload.collectorMode === "google-news" ? "Public news is polling" : payload.collectorMode === "synthetic" ? "Synthetic test feed is polling" : "Browserbase is polling", true);
    renderSessionMeta(payload);
    configureDebugLink(payload.browserbaseSessionUrl || payload.browserbaseDebugUrl);
    await Promise.all([refreshSuggestions(false), refreshEvidence(), refreshStatus()]);
    startPolling();
  } catch (error) {
    setStatus("Connection failed", false);
    elements.sessionMeta.textContent = "Real providers only · session not started";
    showNotice(error instanceof Error ? error.message : String(error));
  } finally {
    elements.start.disabled = false;
  }
}

async function stopSession() {
  clearInterval(pollTimer);
  pollTimer = undefined;
  await fetch(`${API_BASE}/api/session/stop`, { method: "POST" });
  elements.stop.disabled = true;
  elements.refresh.disabled = true;
  setStatus("Stopped", false);
  showNotice("");
}

async function refreshSuggestions(force = false) {
  try {
    const response = await fetch(
      `${API_BASE}${force ? "/api/suggestions/refresh" : "/api/suggestions"}`,
      force ? { method: "POST" } : undefined,
    );
    const payload = await readJson(response);
    if (payload.status !== "ready") {
      elements.moment.textContent = "Gathering enough relevant conversation…";
      return;
    }

    generatedAt = payload.generatedAt;
    thinkingMode = payload.thinkingMode;
    elements.moment.textContent = payload.moment;
    elements.suggestions.replaceChildren(
      ...payload.suggestions.map(suggestionButton),
    );
    setStatus(payload.mode === "local" ? "Using local evidence" : "Gemini is live", true);
    updateAge();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Could not load suggestions");
  }
}

async function refreshStatus() {
  try {
    const payload = await readJson(await fetch(`${API_BASE}/api/session/status`));
    renderSessionMeta(payload);
    if (payload.providerWarning) showNotice(payload.providerWarning, "warning");
    else if (payload.lastError) showNotice(payload.lastError);
  } catch {
    setStatus("Server offline", false);
  }
}

async function refreshEvidence() {
  try {
    const payload = await readJson(await fetch(`${API_BASE}/api/posts?limit=12`));
    const posts = payload.posts ?? [];
    elements.evidenceMeta.textContent = posts.length
      ? `${posts.length} collected posts shown, mixed across available sources.`
      : "No matching posts yet. Try both teams plus the competition name.";
    elements.posts.replaceChildren(
      ...(posts.length ? posts.map(postCard) : [empty("No posts collected yet.")]),
    );
  } catch {
    elements.posts.replaceChildren(empty("Could not load source evidence."));
  }
}

function suggestionButton(suggestion) {
  const button = document.createElement("button");
  button.className = "suggestion";
  const label = document.createElement("small");
  label.textContent = suggestion.style;
  const text = document.createElement("span");
  text.textContent = suggestion.text;
  button.append(label, text);
  button.addEventListener("click", () => insertIntoDiscord(suggestion.text));
  return button;
}

function postCard(post) {
  const card = document.createElement("article");
  card.className = "post";
  const header = document.createElement("div");
  header.className = "post-header";
  const source = document.createElement("span");
  source.className = "source";
  source.textContent = ({ x: "X (Twitter)", news: "Google News", test: "Test feed" })[post.source] ?? post.source;
  const author = document.createElement("span");
  author.textContent = post.author || "unknown";
  const text = document.createElement("p");
  text.textContent = post.text;
  const link = document.createElement("a");
  link.href = post.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open source ↗";
  header.append(source, author);
  card.append(header, text, link);
  return card;
}

function empty(message) {
  const element = document.createElement("div");
  element.className = "empty-state";
  element.textContent = message;
  return element;
}

function renderSessionMeta(payload) {
  const counts = payload.sourceCounts ?? { x: 0, news: 0, test: 0 };
  const mode = payload.searchMode === "historical" ? "Historical relevance" : "Live / recent";
  const lifecycle = `Pending ${payload.pendingPostCount ?? 0} · Processing ${payload.inFlightPostCount ?? 0} · Context ${payload.recentContextCount ?? 0}`;
  elements.sessionMeta.textContent = `${mode} · ${payload.postCount ?? 0} posts · ${lifecycle} · X ${counts.x} · News ${counts.news} · Test ${counts.test ?? 0} · ${payload.collectorMode ?? "collector"} + ${payload.generatorMode ?? "generator"}`;
  renderSourceStatus(payload.sourceStatuses ?? {});
}

function renderSourceStatus(statuses) {
  const labels = { x: "X", news: "News", test: "Test feed" };
  const enabled = Object.keys(labels).filter((source) => statuses[source]?.state !== "idle");
  elements.sourceStatus.replaceChildren(
    ...enabled.map((source) => {
      const status = statuses[source];
      const chip = document.createElement("span");
      chip.className = `source-chip ${status.state}`;
      chip.textContent = `${labels[source]}: ${sourceStateLabel(status)}`;
      if (status.error) chip.title = status.error;
      return chip;
    }),
  );
}

function sourceStateLabel(status) {
  if (status.state === "starting") return "connecting";
  if (status.state === "error") return "error";
  return `${status.postCount ?? 0} pulled`;
}

function configureDebugLink(url) {
  if (!url) {
    elements.debugLink.classList.add("hidden");
    return;
  }
  elements.debugLink.href = url;
  elements.debugLink.classList.remove("hidden");
}

async function insertIntoDiscord(text) {
  showNotice("");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
    await copyFallback(text, "Open Discord Web, then click the suggestion again.");
    return;
  }

  try {
    const result = await sendInsertMessage(tab.id, text);
    if (!result?.ok) throw new Error(result?.error || "Insertion failed");
    showNotice("Pasted into Discord — review it, then press Enter.", "success");
  } catch (error) {
    await copyFallback(
      text,
      `${error instanceof Error ? error.message : "Insertion failed"} Copied instead.`,
    );
  }
}

async function sendInsertMessage(tabId, text) {
  return sendContentMessage(tabId, { type: "INSERT_SUGGESTION", text });
}

async function sendContentMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!(error instanceof Error) || !/receiving end|message port/i.test(error.message)) {
      throw error;
    }
    if (!chrome.scripting?.executeScript) {
      throw new Error("Reload iK(no)w Ball in chrome://extensions, then reload Discord.");
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function readRecentMessages() {
  elements.replyTo.value = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
    showNotice("Open a Discord channel before reading recent messages.");
    return;
  }

  elements.readReply.disabled = true;
  showNotice("Reading the last 10 Discord messages…");
  try {
    const result = await sendContentMessage(tab.id, { type: "READ_RECENT_MESSAGES" });
    if (!result?.ok) throw new Error(result?.error || "Could not read Discord messages.");
    if (!result.messages?.length) {
      throw new Error("No recent chat messages were found.");
    }
    elements.replyTo.value = result.messages.join("\n").slice(-1_000);
    elements.replyTo.disabled = false;
    elements.manualReply.classList.remove("active");
    elements.readReply.classList.add("active");
    const contextResponse = await fetch(`${API_BASE}/api/session/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyTo: elements.replyTo.value }),
    });
    await readJson(contextResponse);
    void refreshSuggestions(false);
    showNotice(`Loaded ${result.messages.length} recent messages. Refreshing suggestions…`);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Could not read Discord messages.");
  } finally {
    elements.readReply.disabled = false;
  }
}

async function copyFallback(text, message) {
  await navigator.clipboard.writeText(text);
  showNotice(message);
}

function setStatus(text, live) {
  elements.status.textContent = text;
  elements.statusDot.classList.toggle("live", live);
}

function showNotice(text, tone = "") {
  elements.notice.textContent = text;
  elements.notice.classList.toggle("success", tone === "success");
  elements.notice.classList.toggle("warning", tone === "warning");
}

function thinkingModeLabel(mode) {
  if (mode === "fast") return "Fast";
  if (mode === "deep") return "Deep thinking";
  if (mode === "medium") return "Medium";
  return "";
}

function updateAge() {
  if (!generatedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 1_000));
  const mode = thinkingModeLabel(thinkingMode);
  elements.updated.textContent = mode
    ? `Updated ${seconds}s ago · ${mode}`
    : `Updated ${seconds}s ago`;
}

startPolling();
setInterval(updateAge, 1_000);

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void refreshSuggestions();
    void refreshStatus();
    void refreshEvidence();
  }, 3_000);
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok && response.status !== 202) {
    const error = payload.error;
    throw new Error(typeof error === "string" ? error : error?.formErrors?.[0] || Object.values(error?.fieldErrors ?? {}).flat()[0] || "Request failed");
  }
  return payload;
}
