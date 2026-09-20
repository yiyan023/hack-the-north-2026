chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "INSERT_SUGGESTION" || typeof message.text !== "string") {
    return false;
  }

  const composer = findChatComposer();

  if (!(composer instanceof HTMLElement)) {
    sendResponse({ ok: false, error: "Open a Discord channel and try again." });
    return false;
  }

  composer.focus();
  const selection = window.getSelection();
  if (!selection?.rangeCount || !composer.contains(selection.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  const beforeInput = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: message.text,
  });
  const beforeInputAccepted = !composer.dispatchEvent(beforeInput) || beforeInput.defaultPrevented;
  const inserted = beforeInputAccepted || document.execCommand("insertText", false, message.text);
  if (!inserted) {
    sendResponse({ ok: false, error: "Discord did not accept an editable insertion." });
    return false;
  }

  sendResponse({ ok: true });
  return false;
});

function findChatComposer() {
  const candidates = [
    ...document.querySelectorAll(
      '[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"]',
    ),
  ];

  const composer = candidates
    .filter((candidate) => candidate instanceof HTMLElement)
    .sort((left, right) => composerScore(right) - composerScore(left))[0];
  return composer && composerScore(composer) >= 10 ? composer : undefined;
}

function composerScore(element) {
  const label = [
    element.getAttribute("aria-label") || "",
    element.getAttribute("data-placeholder") || "",
    element.getAttribute("placeholder") || "",
  ].join(" ");
  const score = /message|chat|reply/i.test(label) ? 10 : 0;
  const slate = element.matches('[data-slate-editor="true"]') ? 5 : 0;
  const textbox = element.getAttribute("role") === "textbox" ? 2 : 0;
  return score + slate + textbox;
}
