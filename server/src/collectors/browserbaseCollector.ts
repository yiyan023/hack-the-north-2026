import { Browserbase } from "@browserbasehq/sdk";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { config } from "../config.js";
import { elapsedMs, logError, logInfo, logWarn } from "../observability.js";
import { buildSearchUrl, classifySearchMode } from "../searchMode.js";
import type {
  Collector,
  CollectorDetails,
  SocialPost,
  Source,
} from "../types.js";

export class BrowserbaseCollector implements Collector {
  private readonly client: Browserbase;
  private readonly contextId: string;
  private browser?: Browser;
  private browserContext?: BrowserContext;
  private sessionId?: string;
  private sessionUrl?: string;
  private debugUrl?: string;
  private initialization?: Promise<void>;
  private operation = Promise.resolve();
  private pages = new Map<Source, Page>();
  private active = false;
  private activeQuery = "";
  private hasCollectedLoadedPages = false;
  private collectionSequence = 0;

  constructor(apiKey: string, contextId = "") {
    this.client = new Browserbase({ apiKey });
    this.contextId = contextId;
  }

  async prewarm(): Promise<CollectorDetails> {
    await this.ensureSession();
    return this.details(classifySearchMode("live"));
  }

  async start(query: string, sources: Source[]): Promise<CollectorDetails> {
    return this.runExclusive(async () => {
      const startAt = Date.now();
      this.hasCollectedLoadedPages = false;
      this.collectionSequence = 0;
      const searchMode = classifySearchMode(query);
      this.activeQuery = query;
      const browserSources = sources.filter(
        (source): source is "x" => source === "x",
      );
      if (browserSources.length === 0) {
        throw new Error("Select X before starting Browserbase.");
      }
      logInfo("browserbase", "collector.start.begin", {
        query,
        sources: browserSources.join(","),
        warmSession: Boolean(this.browser),
      });

      await this.ensureSession();
      const page = this.pages.get("x");
      if (!page) throw new Error("Browserbase warm session has no X page");
      const targetUrl = buildSearchUrl("x", query, searchMode);
      if (page.url() !== targetUrl) {
        const navigationAt = Date.now();
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        logInfo("browserbase", "navigation.domcontentloaded", {
          sessionId: this.sessionId,
          source: "x",
          url: page.url(),
          durationMs: elapsedMs(navigationAt),
        });
        await this.waitForXResults(page);
      } else {
        logInfo("browserbase", "navigation.reused", {
          sessionId: this.sessionId,
          source: "x",
          url: page.url(),
        });
      }

      this.active = true;
      logInfo("browserbase", "collector.start.end", {
        sessionId: this.sessionId,
        sources: browserSources.join(","),
        durationMs: elapsedMs(startAt),
      });
      return this.details(searchMode);
    });
  }

  async collect(): Promise<SocialPost[]> {
    return this.runExclusive(() => this.collectActivePage());
  }

  async stop(): Promise<void> {
    this.active = false;
    this.hasCollectedLoadedPages = false;
    logInfo("browserbase", "collector.paused", {
      sessionId: this.sessionId,
      pages: this.pages.size,
    });
  }

  async shutdown(): Promise<void> {
    await this.runExclusive(async () => {
      const shutdownAt = Date.now();
      await this.initialization?.catch(() => undefined);
      this.active = false;
      this.hasCollectedLoadedPages = false;
      await this.resetSession();
      logInfo("browserbase", "session.shutdown", {
        durationMs: elapsedMs(shutdownAt),
      });
    });
  }

  snapshot() {
    return {
      ready: Boolean(this.browser && this.sessionId),
      sessionId: this.sessionId,
      sessionUrl: this.sessionUrl,
      debugUrl: this.debugUrl,
      active: this.active,
    };
  }

  private async ensureSession(): Promise<void> {
    if (this.browser && this.sessionId) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeSession().catch(async (error) => {
      await this.resetSession();
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async initializeSession(): Promise<void> {
    const initializeAt = Date.now();
    logInfo("browserbase", "prewarm.begin", {
      context: this.contextId ? "configured" : "missing",
      region: config.browserbaseRegion,
      timeoutSec: config.browserbaseSessionTimeoutSec,
    });
    let session;
    const createAt = Date.now();
    try {
      const sessionParams: Browserbase.SessionCreateParams = {
        region: config.browserbaseRegion,
        api_timeout: config.browserbaseSessionTimeoutSec,
        ...(this.contextId
          ? {
              browserSettings: {
                context: {
                  id: this.contextId,
                  // The one-time login setup persists cookies; collection sessions are read-only.
                  persist: false,
                },
              },
            }
          : {}),
      };
      session = await this.client.sessions.create(sessionParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("browserbase", "session.create.error", error, {
        durationMs: elapsedMs(createAt),
      });
      if (/401|unauthorized/i.test(message)) {
        throw new Error(
          "Browserbase rejected BROWSERBASE_API_KEY (401). Add a current Dashboard API key to .env.",
        );
      }
      throw error;
    }
    logInfo("browserbase", "session.create.end", {
      sessionId: session.id,
      durationMs: elapsedMs(createAt),
    });

    const connectAt = Date.now();
    this.browser = await chromium.connectOverCDP(session.connectUrl);
    this.sessionId = session.id;
    this.sessionUrl = `https://browserbase.com/sessions/${session.id}`;
    logInfo("browserbase", "cdp.connect.end", {
      sessionId: session.id,
      durationMs: elapsedMs(connectAt),
    });

    this.browserContext = this.browser.contexts()[0];
    if (!this.browserContext) throw new Error("Browserbase returned no browser context");

    const page = this.browserContext.pages()[0] ?? await this.browserContext.newPage();
    this.pages.set("x", page);
    if (!page.url().startsWith("https://x.com/")) {
      const navigationAt = Date.now();
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      logInfo("browserbase", "prewarm.navigation.end", {
        sessionId: session.id,
        url: page.url(),
        durationMs: elapsedMs(navigationAt),
      });
    }

    void this.loadDebugUrl(session.id);
    logInfo("browserbase", "prewarm.end", {
      sessionId: session.id,
      durationMs: elapsedMs(initializeAt),
    });
  }

  private details(searchMode: ReturnType<typeof classifySearchMode>): CollectorDetails {
    return {
      mode: "browserbase",
      searchMode,
      sessionId: this.sessionId,
      sessionUrl: this.sessionUrl,
      debugUrl: this.debugUrl,
    };
  }

  private async collectActivePage(): Promise<SocialPost[]> {
    if (!this.active) return [];
    // start() already navigates every page and waits for its results. Extract
    // that rendered DOM on the first collection instead of paying for an
    // immediate duplicate reload. Scheduled collections still reload so they
    // receive fresh posts.
    const shouldReload = this.hasCollectedLoadedPages;
    this.hasCollectedLoadedPages = true;
    const collectionId = ++this.collectionSequence;
    const collectAt = Date.now();
    logInfo("browserbase", "collect.begin", {
      collectionId,
      sources: [...this.pages.keys()].join(","),
      reload: shouldReload,
    });
    const results = await Promise.allSettled(
      [...this.pages.entries()].map(async ([source, page]) => {
        const sourceAt = Date.now();
        if (shouldReload) {
          const reloadAt = Date.now();
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
          logInfo("browserbase", "reload.domcontentloaded", {
            collectionId,
            source,
            url: page.url(),
            durationMs: elapsedMs(reloadAt),
          });
          if (source === "x") {
            await this.waitForXResults(page);
          }
        }
        const extractionAt = Date.now();
        const extracted = await this.extractXPosts(page);
        const relevant = extracted.filter((post) =>
          matchesLiveQuery(post.text, this.activeQuery),
        );
        logInfo("browserbase", "extract.end", {
          collectionId,
          source,
          posts: relevant.length,
          rejectedPosts: extracted.length - relevant.length,
          durationMs: elapsedMs(extractionAt),
          sourceTotalMs: elapsedMs(sourceAt),
        });
        return relevant;
      }),
    );

    const posts = results.flatMap((result, index) => {
      const source = [...this.pages.keys()][index] ?? "unknown";
      if (result.status === "fulfilled") return result.value;
      logError("browserbase", "collect.source.error", result.reason, {
        collectionId,
        source,
      });
      return [];
    });
    logInfo("browserbase", "collect.end", {
      collectionId,
      posts: posts.length,
      durationMs: elapsedMs(collectAt),
    });
    return posts;
  }

  private async loadDebugUrl(sessionId: string): Promise<void> {
    const debugAt = Date.now();
    try {
      const debug = await this.client.sessions.debug(sessionId);
      if (this.sessionId === sessionId) {
        this.debugUrl = debug.debuggerFullscreenUrl;
      }
      logInfo("browserbase", "debug-link.end", {
        sessionId,
        durationMs: elapsedMs(debugAt),
      });
    } catch (error) {
      logWarn("browserbase", "debug-link.unavailable", {
        sessionId,
        durationMs: elapsedMs(debugAt),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async resetSession(): Promise<void> {
    const browser = this.browser;
    this.pages.clear();
    this.browser = undefined;
    this.browserContext = undefined;
    this.sessionId = undefined;
    this.sessionUrl = undefined;
    this.debugUrl = undefined;
    this.initialization = undefined;
    await browser?.close().catch(() => undefined);
  }

  private async extractXPosts(page: Page): Promise<SocialPost[]> {
    const posts = await page.locator("article").evaluateAll((articles) => {
      const collectedAt = new Date().toISOString();
      return articles
        .map((article) => {
          const statusLink = article.querySelector<HTMLAnchorElement>(
            'a[href*="/status/"]',
          );
          const text = article
            .querySelector<HTMLElement>('[data-testid="tweetText"]')
            ?.innerText.trim();
          const time = article.querySelector<HTMLTimeElement>("time")?.dateTime;
          const author = article
            .querySelector<HTMLElement>('[data-testid="User-Name"]')
            ?.innerText.split("\n")[0]
            ?.trim();
          const href = statusLink?.getAttribute("href");
          if (!href || !text) return null;

          const url = new URL(href, "https://x.com").toString();
          return {
            id: `x:${url}`,
            source: "x" as const,
            author: author || "unknown",
            text,
            url,
            publishedAt: time || collectedAt,
            collectedAt,
          };
        })
        .filter((post): post is NonNullable<typeof post> => post !== null);
    });
    if (posts.length > 0) return posts;

    return page.locator('[data-testid="tweetText"]').evaluateAll((tweetTexts) => {
      const collectedAt = new Date().toISOString();
      return tweetTexts.flatMap((tweetText) => {
        const container = tweetText.closest("[data-testid=\"cellInnerDiv\"]") || tweetText.parentElement;
        const statusLink = container?.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
        const href = statusLink?.getAttribute("href");
        const text = tweetText.textContent?.trim();
        if (!href || !text) return [];

        const time = container?.querySelector<HTMLTimeElement>("time")?.dateTime;
        const author = container
          ?.querySelector<HTMLElement>('[data-testid="User-Name"]')
          ?.innerText.split("\n")[0]
          ?.trim();
        const url = new URL(href, "https://x.com").toString();
        return [{
          id: `x:${url}`,
          source: "x" as const,
          author: author || "unknown",
          text,
          url,
          publishedAt: time || collectedAt,
          collectedAt,
        }];
      });
    });
  }

  private async waitForXResults(page: Page): Promise<void> {
    const waitAt = Date.now();
    const currentUrl = page.url();
    logInfo("browserbase", "x-results.wait.begin", { url: currentUrl });
    if (/\/login|\/onboarding\/|mode=login/i.test(currentUrl)) {
      logError(
        "browserbase",
        "x-results.authentication-required",
        new Error("X is showing a login or onboarding page"),
        { url: currentUrl, durationMs: elapsedMs(waitAt) },
      );
      throw new Error(
        "X is not logged in inside the Browserbase context. Complete one manual X login in a persist:true Browserbase session, close it, and wait a few seconds before retrying.",
      );
    }

    // X may render tweet text without article containers depending on its
    // current client markup. Wait for either result shape.
    try {
      await page.locator('article, [data-testid="tweetText"]').first().waitFor({
        state: "attached",
        timeout: 30_000,
      });
    } catch (error) {
      const bodyText = (await page.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      logError("browserbase", "x-results.wait.error", error, {
        url: page.url(),
        title: await page.title(),
        body: bodyText,
        durationMs: elapsedMs(waitAt),
      });
      throw error;
    }
    const articleCount = await page.locator("article").count();
    const tweetCount = await page.locator('[data-testid="tweetText"]').count();
    logInfo("browserbase", "x-results.wait.end", {
      url: page.url(),
      articles: articleCount,
      tweetTexts: tweetCount,
      durationMs: elapsedMs(waitAt),
    });
  }

}

function matchesLiveQuery(text: string, query: string) {
  const targetYears = new Set(query.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  const postYears = text.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  if (
    targetYears.size > 0 &&
    postYears.length > 0 &&
    !postYears.some((year) => targetYears.has(year))
  ) {
    return false;
  }

  const generic = new Set([
    "championship",
    "championships",
    "cup",
    "final",
    "finals",
    "game",
    "live",
    "match",
    "open",
    "the",
    "tournament",
    "versus",
  ]);
  const distinctive = (query.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [])
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d{4}$/.test(token) && !generic.has(token));
  if (distinctive.length === 0) return true;

  const normalizedText = text.toLowerCase();
  const matchingTokens = distinctive.filter((token) =>
    normalizedText.includes(token),
  ).length;
  return matchingTokens >= Math.ceil(distinctive.length * 0.6);
}

export const testing = { matchesLiveQuery };
