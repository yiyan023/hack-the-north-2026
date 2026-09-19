chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "INSERT_SUGGESTION" || typeof message.text !== "string") {
    return false;
  }

  const composer = document.querySelector(
    '[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"]',
  );

  if (!(composer instanceof HTMLElement)) {
    sendResponse({ ok: false, error: "Open a Discord channel and try again." });
    return false;
  }

  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = document.execCommand("insertText", false, message.text);
  if (!inserted) {
    sendResponse({ ok: false, error: "Discord rejected direct insertion." });
    return false;
  }

  sendResponse({ ok: true });
  return false;
});
