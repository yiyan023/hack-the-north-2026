import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../src/sessionService.js";
import type { BrowserbaseCollector } from "../src/collectors/browserbaseCollector.js";
import type { Collector, SocialPost, Source } from "../src/types.js";

function post(source: Source, id: string, text: string): SocialPost {
  return {
    id: `${source}:${id}`,
    source,
    author: `${source} author`,
    text,
    url: `https://example.com/${source}/${id}`,
    publishedAt: "2026-09-20T00:00:00.000Z",
    collectedAt: "2026-09-20T00:00:01.000Z",
  };
}

function fakeCollector(
  source: "x" | "news",
  posts: SocialPost[] | (() => Promise<SocialPost[]>),
): Collector & {
  start: ReturnType<typeof vi.fn>;
  collect: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockResolvedValue({
      mode: source === "x" ? "browserbase" : "google-news",
      searchMode: "live",
      ...(source === "x"
        ? {
            sessionId: "warm-session",
            sessionUrl: "https://browserbase.com/sessions/warm-session",
          }
        : {}),
    }),
    collect: vi.fn(
      typeof posts === "function" ? posts : async () => posts,
    ),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeBrowserbase(collector: ReturnType<typeof fakeCollector>) {
  return Object.assign(collector, {
    prewarm: vi.fn().mockResolvedValue({
      mode: "browserbase",
      searchMode: "live",
      sessionId: "warm-session",
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn(() => ({
      ready: true,
      active: false,
      sessionId: "warm-session",
      sessionUrl: "https://browserbase.com/sessions/warm-session",
    })),
  }) as unknown as BrowserbaseCollector;
}

const services: SessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
});

describe("SessionService source isolation", () => {
  it("reuses one prewarmed Browserbase collector across Start Watching clicks", async () => {
    const x = fakeCollector("x", []);
    const service = new SessionService(fakeBrowserbase(x));
    services.push(service);

    const first = await service.start({
      game: "Arsenal Chelsea",
      sources: ["x"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });
    const second = await service.start({
      game: "World Cup",
      sources: ["x"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });

    expect(x.start).toHaveBeenCalledTimes(2);
    expect(x.stop).toHaveBeenCalledOnce();
    expect(first.browserbaseSessionId).toBe("warm-session");
    expect(second.browserbaseSessionId).toBe("warm-session");
  });

  it("collects only News and hides the prewarmed X session for News-only", async () => {
    const x = fakeCollector("x", [post("x", "1", "X evidence")]);
    const news = fakeCollector("news", [post("news", "1", "News evidence")]);
    const service = new SessionService(fakeBrowserbase(x), () => news);
    services.push(service);

    const snapshot = await service.start({
      game: "2026 badminton championships",
      sources: ["news"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });

    expect(x.start).not.toHaveBeenCalled();
    expect(x.collect).not.toHaveBeenCalled();
    expect(news.start).toHaveBeenCalledWith("2026 badminton championships", ["news"]);
    expect(service.posts(10).map((item) => item.source)).toEqual(["news"]);
    expect(snapshot).toMatchObject({
      sources: ["news"],
      collectorMode: "google-news",
      browserbaseReady: false,
      browserbaseActive: false,
      sourceCounts: { x: 0, news: 1, test: 0 },
    });
    expect(snapshot.browserbaseSessionUrl).toBeUndefined();
  });

  it("does not tear down a working session when a new source selection is invalid", async () => {
    const x = fakeCollector("x", []);
    const news = fakeCollector("news", []);
    const service = new SessionService(fakeBrowserbase(x), () => news);
    services.push(service);

    await service.start({
      game: "Arsenal Chelsea",
      sources: ["news"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });

    await expect(
      service.start({
        game: "Invalid mixed test",
        sources: ["news", "test"],
        toneExamples: [],
        replyTo: "",
        thinkingMode: "fast",
      }),
    ).rejects.toThrow("must be selected by itself");

    expect(news.stop).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({
      status: "collecting",
      game: "Arsenal Chelsea",
      sources: ["news"],
    });
  });

  it("waits for every selected source before the first combined poll", async () => {
    let releaseX!: () => void;
    const xReady = new Promise<void>((resolve) => {
      releaseX = resolve;
    });
    const x = fakeCollector("x", []);
    x.start.mockImplementation(async () => {
      await xReady;
      return {
        mode: "browserbase",
        searchMode: "live",
        sessionId: "warm-session",
      };
    });
    const news = fakeCollector("news", []);
    const service = new SessionService(fakeBrowserbase(x), () => news);
    services.push(service);

    let settled = false;
    const starting = service.start({
      game: "Arsenal Chelsea",
      sources: ["x", "news"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    }).then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(news.start).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(news.collect).not.toHaveBeenCalled();
    releaseX();
    await starting;

    expect(x.collect).toHaveBeenCalledOnce();
    expect(news.collect).toHaveBeenCalledOnce();
  });

  it("discards an old poll that finishes after switching sessions", async () => {
    let releaseOldPoll!: (posts: SocialPost[]) => void;
    let markOldPollStarted!: () => void;
    const oldPollStarted = new Promise<void>((resolve) => {
      markOldPollStarted = resolve;
    });
    const oldPoll = new Promise<SocialPost[]>((resolve) => {
      releaseOldPoll = resolve;
    });
    const first = fakeCollector("news", async () => {
      markOldPollStarted();
      return oldPoll;
    });
    const second = fakeCollector("news", [post("news", "new", "New game evidence")]);
    const factories = [first, second];
    const x = fakeCollector("x", []);
    const service = new SessionService(
      fakeBrowserbase(x),
      () => factories.shift() ?? second,
    );
    services.push(service);

    const oldStart = service.start({
      game: "Old game",
      sources: ["news"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });
    await oldPollStarted;

    await service.start({
      game: "New game",
      sources: ["news"],
      toneExamples: [],
      replyTo: "",
      thinkingMode: "fast",
    });
    releaseOldPoll([post("news", "old", "Old game evidence")]);
    await oldStart;

    expect(service.posts(10).map((item) => item.text)).toEqual([
      "New game evidence",
    ]);
    expect(service.snapshot()).toMatchObject({
      game: "New game",
      sources: ["news"],
      sourceCounts: { x: 0, news: 1, test: 0 },
    });
  });
});
