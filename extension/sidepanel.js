const API_BASE = "http://localhost:3000";
const elements = {
  game: document.querySelector("#game"),
  tone: document.querySelector("#tone"),
  sourceX: document.querySelector("#source-x"),
  sourceReddit: document.querySelector("#source-reddit"),
  start: document.querySelector("#start"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#status-dot"),
  updated: document.querySelector("#updated"),
  moment: document.querySelector("#moment"),
  suggestions: document.querySelector("#suggestions"),
  notice: document.querySelector("#notice"),
  debugLink: document.querySelector("#debug-link"),
};

let generatedAt;

chrome.storage.local.get(["game", "tone"], (saved) => {
  if (saved.game) elements.game.value = saved.game;
  if (saved.tone) elements.tone.value = saved.tone;
});

elements.start.addEventListener("click", async () => {
  const game = elements.game.value.trim();
  const sources = [
    elements.sourceX.checked ? "x" : null,
    elements.sourceReddit.checked ? "reddit" : null,
  ].filter(Boolean);

  if (!game || sources.length === 0) {
    showNotice("Enter a game and select at least one source.");
    return;
  }

  elements.start.disabled = true;
  showNotice("");
  setStatus("Starting…", false);

  try {
    const toneExamples = elements.tone.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const response = await fetch(`${API_BASE}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game, sources, toneExamples }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not start session");

    chrome.storage.local.set({ game, tone: elements.tone.value });
    setStatus(payload.collectorMode === "demo" ? "Demo is live" : "Watching live", true);
    if (payload.browserbaseDebugUrl) {
      elements.debugLink.href = payload.browserbaseDebugUrl;
      elements.debugLink.classList.remove("hidden");
    }
    await refreshSuggestions();
  } catch (error) {
    setStatus("Connection failed", false);
    showNotice(error instanceof Error ? error.message : String(error));
  } finally {
    elements.start.disabled = false;
  }
});

async function refreshSuggestions() {
  try {
    const response = await fetch(`${API_BASE}/api/suggestions`);
    const payload = await response.json();
    if (!response.ok && response.status !== 202) {
      throw new Error(payload.error || "Could not load suggestions");
    }
    if (payload.status !== "ready") {
      elements.moment.textContent = "Gathering enough conversation…";
      return;
    }

    generatedAt = payload.generatedAt;
    elements.moment.textContent = payload.moment;
    elements.suggestions.replaceChildren(
      ...payload.suggestions.map(suggestionButton),
    );
    setStatus(payload.mode === "demo" ? "Demo is live" : "Watching live", true);
    updateAge();
  } catch {
    setStatus("Server offline", false);
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

async function insertIntoDiscord(text) {
  showNotice("");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
    await copyFallback(text, "Open Discord Web, then click the suggestion again.");
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "INSERT_SUGGESTION",
      text,
    });
    if (!result?.ok) throw new Error(result?.error || "Insertion failed");
    showNotice("Pasted into Discord — review it, then press Enter.");
  } catch (error) {
    await copyFallback(
      text,
      `${error instanceof Error ? error.message : "Insertion failed"} Copied instead.`,
    );
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

function showNotice(text) {
  elements.notice.textContent = text;
}

function updateAge() {
  if (!generatedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 1_000));
  elements.updated.textContent = `Updated ${seconds}s ago`;
}

setInterval(refreshSuggestions, 3_000);
setInterval(updateAge, 1_000);
