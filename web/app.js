const elements = {
  game: document.querySelector("#game"),
  replyTo: document.querySelector("#reply-to"),
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
  moment: document.querySelector("#moment"),
  suggestions: document.querySelector("#suggestions"),
  posts: document.querySelector("#posts"),
  evidenceMeta: document.querySelector("#evidence-meta"),
  notice: document.querySelector("#notice"),
  debugLink: document.querySelector("#debug-link"),
  serverDot: document.querySelector("#server-dot"),
  serverLabel: document.querySelector("#server-label"),
};

let generatedAt;
let pollTimer;

restoreForm();
checkHealth();

document.querySelectorAll("[data-game]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.game.value = button.dataset.game;
  });
});

elements.start.addEventListener("click", startSession);
elements.stop.addEventListener("click", stopSession);
elements.refresh.addEventListener("click", () => refreshSuggestions(true));

async function startSession() {
  const game = elements.game.value.trim();
  const sources = [
    elements.sourceX.checked ? "x" : null,
    elements.sourceNews.checked ? "news" : null,
    elements.sourceTest?.checked ? "test" : null,
  ].filter(Boolean);

  if (!game || sources.length === 0) {
    showNotice("Enter a game and select at least one source.");
    return;
  }

  setBusy(true);
  showNotice("");
  setStatus("Starting source collector…", false);
  elements.suggestions.innerHTML = '<div class="empty-state">Collecting evidence and preparing suggestions…</div>';
  elements.posts.innerHTML = '<div class="empty-state">Waiting for the first real-data pull…</div>';

  try {
    const toneExamples = elements.tone.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game,
        sources,
        toneExamples,
        replyTo: elements.replyTo.value.trim(),
        thinkingMode: elements.thinkingMode.value,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatError(payload.error));

    saveForm();
    elements.stop.disabled = false;
    elements.refresh.disabled = false;
    setStatus(payload.collectorMode === "google-news" ? "Public news is polling" : "Browserbase is polling", true);
    renderSessionMeta(payload);
    configureDebugLink(payload.browserbaseSessionUrl || payload.browserbaseDebugUrl);
    await Promise.all([refreshSuggestions(false), refreshEvidence(), refreshStatus()]);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void refreshStatus();
      void refreshSuggestions(false);
      void refreshEvidence();
    }, 3_000);
  } catch (error) {
    setStatus("Could not start", false);
    elements.sessionMeta.textContent = "Real providers only · session not started";
    elements.moment.textContent = "No talking point was generated.";
    elements.suggestions.replaceChildren(empty("No suggestions generated."));
    elements.evidenceMeta.textContent = "The selected source did not return evidence.";
    elements.posts.replaceChildren(empty("No source posts collected."));
    showNotice(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function stopSession() {
  clearInterval(pollTimer);
  await fetch("/api/session/stop", { method: "POST" });
  elements.stop.disabled = true;
  elements.refresh.disabled = true;
  setStatus("Stopped", false);
  showNotice("");
}

async function refreshStatus() {
  try {
    const payload = await readJson(await fetch("/api/session/status"));
    renderSessionMeta(payload);
    if (payload.providerWarning) showNotice(payload.providerWarning);
    else if (payload.lastError) showNotice(payload.lastError);
  } catch {
    setStatus("Server offline", false);
  }
}

async function refreshSuggestions(force) {
  try {
    const response = await fetch(
      force ? "/api/suggestions/refresh" : "/api/suggestions",
      force ? { method: "POST" } : undefined,
    );
    const payload = await readJson(response);
    if (payload.status !== "ready") {
      elements.moment.textContent = "Gathering enough relevant conversation…";
      return;
    }

    generatedAt = payload.generatedAt;
    elements.moment.textContent = payload.moment;
    elements.suggestions.replaceChildren(
      ...payload.suggestions.map(suggestionCard),
    );
    updateAge(payload.thinkingMode);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Could not load suggestions");
  }
}

async function refreshEvidence() {
  try {
    const payload = await readJson(await fetch("/api/posts?limit=12"));
    const posts = payload.posts ?? [];
    elements.evidenceMeta.textContent = posts.length
      ? `${posts.length} recent posts shown. These are the inputs behind the suggestions.`
      : "No matching posts yet. Try both teams plus the competition name.";
    elements.posts.replaceChildren(
      ...(posts.length ? posts.map(postCard) : [empty("No posts collected yet.")]),
    );
  } catch {
    elements.posts.replaceChildren(empty("Could not load source evidence."));
  }
}

function suggestionCard(suggestion) {
  const card = document.createElement("article");
  card.className = "suggestion";
  const content = document.createElement("div");
  const label = document.createElement("small");
  label.textContent = suggestion.style;
  const text = document.createElement("p");
  text.textContent = suggestion.text;
  content.append(label, text);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    await copyText(suggestion.text);
    copy.textContent = "Copied";
    copy.classList.add("copied");
    setTimeout(() => {
      copy.textContent = "Copy";
      copy.classList.remove("copied");
    }, 1_500);
  });
  card.append(content, copy);
  return card;
}

function postCard(post) {
  const card = document.createElement("article");
  card.className = "post";
  const header = document.createElement("div");
  header.className = "post-header";
  const source = document.createElement("span");
  source.className = "source";
  source.textContent = post.source;
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
  const sourceCounts = payload.sourceCounts ?? { x: 0, news: 0, test: 0 };
  const mode = payload.searchMode === "historical" ? "Historical relevance" : "Live / recent";
  const providers = `${payload.collectorMode ?? "collector"} + ${payload.generatorMode ?? "generator"}`;
  const lifecycle = `Pending ${payload.pendingPostCount ?? 0} · Processing ${payload.inFlightPostCount ?? 0} · Context ${payload.recentContextCount ?? 0}`;
  elements.sessionMeta.textContent = `${mode} · ${payload.postCount ?? 0} posts · ${lifecycle} · X ${sourceCounts.x} · News ${sourceCounts.news} · Test ${sourceCounts.test ?? 0} · ${providers}`;
}

function configureDebugLink(url) {
  if (!url) {
    elements.debugLink.classList.add("hidden");
    return;
  }
  elements.debugLink.href = url;
  elements.debugLink.classList.remove("hidden");
}

function setBusy(busy) {
  elements.start.disabled = busy;
  elements.start.textContent = busy ? "Starting…" : "Start watching";
}

function setStatus(text, live) {
  elements.status.textContent = text;
  elements.statusDot.classList.toggle("live", live);
}

function showNotice(text) {
  elements.notice.textContent = text;
}

function updateAge(thinkingMode) {
  if (!generatedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 1_000));
  elements.updated.textContent = `Updated ${seconds}s ago · ${thinkingMode}`;
}

async function checkHealth() {
  try {
    const response = await fetch("/health");
    if (!response.ok) throw new Error("offline");
    elements.serverLabel.textContent = "Local server online";
    elements.serverDot.classList.add("live");
  } catch {
    elements.serverLabel.textContent = "Local server offline";
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function saveForm() {
  localStorage.setItem("iknowball-form", JSON.stringify({
    game: elements.game.value,
    replyTo: elements.replyTo.value,
    tone: elements.tone.value,
    thinkingMode: elements.thinkingMode.value,
    sourceX: elements.sourceX.checked,
    sourceNews: elements.sourceNews.checked,
  }));
}

function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem("iknowball-form") || "null");
    if (!saved) return;
    elements.game.value = saved.game ?? "";
    elements.replyTo.value = saved.replyTo ?? "";
    elements.tone.value = saved.tone ?? "";
    elements.thinkingMode.value = saved.thinkingMode ?? "medium";
    const migrated = !("sourceNews" in saved);
    elements.sourceX.checked = migrated ? false : Boolean(saved.sourceX);
    elements.sourceNews.checked = migrated ? true : saved.sourceNews !== false;
  } catch {
    localStorage.removeItem("iknowball-form");
  }
}

function formatError(error) {
  if (typeof error === "string") return error;
  return error?.formErrors?.[0] || Object.values(error?.fieldErrors ?? {}).flat()[0] || "Request failed";
}

async function readJson(response) {
  const payload = await response.json();
  if (!response.ok && response.status !== 202) {
    throw new Error(formatError(payload.error));
  }
  return payload;
}
