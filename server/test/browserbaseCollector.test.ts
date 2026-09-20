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
  let currentUrl = "about:blank";
  const page = {
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
    }),
    reload: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => currentUrl),
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
    resetUrl: () => {
      currentUrl = "about:blank";
    },
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
    mocks.resetUrl();
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
      region: "us-east-1",
      api_timeout: 21600,
      browserSettings: {
        context: { id: "context-id", persist: false },
      },
    });
    expect(initialPosts).toEqual([mocks.primaryPost]);
    // One navigation prewarms X; the second redirects the same tab to the game.
    expect(mocks.page.goto).toHaveBeenCalledTimes(2);
    expect(mocks.page.reload).not.toHaveBeenCalled();

    const refreshedPosts = await collector.collect();

    expect(refreshedPosts).toEqual(initialPosts);
    expect(mocks.page.reload).toHaveBeenCalledOnce();
    // Once after start navigation and once after the scheduled reload.
    expect(mocks.waitFor).toHaveBeenCalledTimes(2);
    await collector.stop();
    expect(mocks.browser.close).not.toHaveBeenCalled();
    await collector.shutdown();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  });

  it("keeps the existing tweet-text fallback on the optimized first collection", async () => {
    mocks.articleEvaluateAll.mockResolvedValue([]);
    const collector = new BrowserbaseCollector("api-key", "context-id");

    await collector.start("Arsenal", ["x"]);
    const posts = await collector.collect();

    expect(posts).toEqual([mocks.fallbackPost]);
    expect(mocks.tweetEvaluateAll).toHaveBeenCalledOnce();
    expect(mocks.page.reload).not.toHaveBeenCalled();
    await collector.shutdown();
  });

  it("prewarms once and reuses the same session and X tab across games", async () => {
    const collector = new BrowserbaseCollector("api-key", "context-id");

    await Promise.all([collector.prewarm(), collector.prewarm()]);
    await collector.start("Arsenal", ["x"]);
    await collector.collect();
    await collector.stop();
    await collector.start("Chelsea", ["x"]);
    await collector.collect();

    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.connectOverCDP).toHaveBeenCalledOnce();
    expect(mocks.page.goto).toHaveBeenCalledTimes(3);
    expect(mocks.page.reload).not.toHaveBeenCalled();
    expect(collector.snapshot()).toMatchObject({
      ready: true,
      active: true,
      sessionId: "session-1",
    });

    await collector.shutdown();
  });

  it("does not navigate again when the same game is restarted", async () => {
    const collector = new BrowserbaseCollector("api-key", "context-id");

    await collector.prewarm();
    await collector.start("Arsenal", ["x"]);
    await collector.collect();
    await collector.stop();
    await collector.start("Arsenal", ["x"]);
    await collector.collect();

    expect(mocks.createSession).toHaveBeenCalledOnce();
    // One navigation to X home and one to the Arsenal search URL.
    expect(mocks.page.goto).toHaveBeenCalledTimes(2);
    expect(mocks.page.reload).not.toHaveBeenCalled();
    await collector.shutdown();
  });

  it("can retry prewarming after session creation fails", async () => {
    mocks.createSession.mockRejectedValueOnce(new Error("temporary outage"));
    const collector = new BrowserbaseCollector("api-key", "context-id");

    await expect(collector.prewarm()).rejects.toThrow("temporary outage");
    await expect(collector.prewarm()).resolves.toMatchObject({
      mode: "browserbase",
      sessionId: "session-1",
    });

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.connectOverCDP).toHaveBeenCalledOnce();
    await collector.shutdown();
  });
});
