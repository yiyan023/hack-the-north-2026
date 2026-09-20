import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const primaryPost = {
    id: "x:https://x.com/test/status/1",
    source: "x",
    author: "Test User",
    text: "A loaded post",
    url: "https://x.com/test/status/1",
    publishedAt: "2026-09-19T00:00:00.000Z",
    collectedAt: "2026-09-19T00:00:01.000Z",
  };
  const fallbackPost = {
    ...primaryPost,
    id: "x:https://x.com/test/status/2",
    text: "A fallback-selector post",
    url: "https://x.com/test/status/2",
  };
  const waitFor = vi.fn().mockResolvedValue(undefined);
  const articleEvaluateAll = vi.fn();
  const tweetEvaluateAll = vi.fn();
  const locator = vi.fn((selector: string) => ({
    first: () => ({ waitFor }),
    evaluateAll:
      selector === "article" ? articleEvaluateAll : tweetEvaluateAll,
    count: vi.fn().mockResolvedValue(1),
    innerText: vi.fn().mockResolvedValue("X search results"),
  }));
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => "https://x.com/search?q=Arsenal&f=live"),
    title: vi.fn().mockResolvedValue("Arsenal - Search / X"),
    locator,
  };
  const browser = {
    contexts: vi.fn(() => [
      {
        pages: () => [page],
        newPage: vi.fn().mockResolvedValue(page),
      },
    ]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    articleEvaluateAll,
    browser,
    connectOverCDP: vi.fn().mockResolvedValue(browser),
    createSession: vi.fn().mockResolvedValue({
      id: "session-1",
      connectUrl: "wss://browserbase.test/session-1",
    }),
    debugSession: vi.fn().mockResolvedValue({
      debuggerFullscreenUrl: "https://browserbase.test/sessions/session-1",
    }),
    fallbackPost,
    page,
    primaryPost,
    tweetEvaluateAll,
    waitFor,
  };
});

vi.mock("@browserbasehq/sdk", () => ({
  Browserbase: class {
    sessions = {
      create: mocks.createSession,
      debug: mocks.debugSession,
    };
  },
}));

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: mocks.connectOverCDP,
  },
}));

import { BrowserbaseCollector } from "../src/collectors/browserbaseCollector.js";

describe("BrowserbaseCollector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.articleEvaluateAll.mockResolvedValue([mocks.primaryPost]);
    mocks.tweetEvaluateAll.mockResolvedValue([mocks.fallbackPost]);
  });

  it("extracts the page loaded by start before reloading later collections", async () => {
    const collector = new BrowserbaseCollector("api-key", "context-id");

    const details = await collector.start("Arsenal", ["x"]);
    const initialPosts = await collector.collect();

    expect(details).toMatchObject({
      mode: "browserbase",
      sessionId: "session-1",
      sessionUrl: "https://browserbase.com/sessions/session-1",
    });
    expect(mocks.createSession).toHaveBeenCalledWith({
      browserSettings: {
        context: { id: "context-id", persist: false },
      },
    });
    expect(initialPosts).toEqual([mocks.primaryPost]);
    expect(mocks.page.goto).toHaveBeenCalledOnce();
    expect(mocks.page.reload).not.toHaveBeenCalled();

    const refreshedPosts = await collector.collect();

    expect(refreshedPosts).toEqual(initialPosts);
    expect(mocks.page.reload).toHaveBeenCalledOnce();
    // Once after start navigation and once after the scheduled reload.
    expect(mocks.waitFor).toHaveBeenCalledTimes(2);
    await collector.stop();
  });

  it("keeps the existing tweet-text fallback on the optimized first collection", async () => {
    mocks.articleEvaluateAll.mockResolvedValue([]);
    const collector = new BrowserbaseCollector("api-key", "context-id");

    await collector.start("Arsenal", ["x"]);
    const posts = await collector.collect();

    expect(posts).toEqual([mocks.fallbackPost]);
    expect(mocks.tweetEvaluateAll).toHaveBeenCalledOnce();
    expect(mocks.page.reload).not.toHaveBeenCalled();
    await collector.stop();
  });
});
