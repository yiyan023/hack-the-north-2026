import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
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
  private pages = new Map<Source, Page>();
  private hasCollectedLoadedPages = false;
  private collectionSequence = 0;

  constructor(apiKey: string, contextId = "") {
    this.client = new Browserbase({ apiKey });
    this.contextId = contextId;
  }

  async start(query: string, sources: Source[]): Promise<CollectorDetails> {
    const startAt = Date.now();
    this.hasCollectedLoadedPages = false;
    this.collectionSequence = 0;
    const searchMode = classifySearchMode(query);
    const browserSources = sources.filter(
      (source): source is "x" => source === "x",
    );
    if (browserSources.length === 0) {
      throw new Error("Select X before starting Browserbase.");
    }
    logInfo("browserbase", "collector.start.begin", {
      query,
      sources: browserSources.join(","),
      context: this.contextId ? "configured" : "missing",
      persist: false,
    });
    let session;
    const createAt = Date.now();
    try {
      session = await this.client.sessions.create(
        this.contextId
          ? {
              browserSettings: {
                context: {
                  id: this.contextId,
                  // The one-time login setup persists cookies; collection sessions are read-only.
                  persist: false,
                },
              },
            }
          : undefined,
      );
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
    logInfo("browserbase", "cdp.connect.end", {
      sessionId: session.id,
      durationMs: elapsedMs(connectAt),
    });

    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Browserbase returned no browser context");

    const existingPage = context.pages()[0];
    for (const [index, source] of browserSources.entries()) {
      const navigationAt = Date.now();
      const page = index === 0 && existingPage ? existingPage : await context.newPage();
      await page.goto(buildSearchUrl(source, query, searchMode), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      logInfo("browserbase", "navigation.domcontentloaded", {
        sessionId: session.id,
        source,
        url: page.url(),
        durationMs: elapsedMs(navigationAt),
      });
      if (source === "x") {
        await this.waitForXResults(page);
      }
      this.pages.set(source, page);
    }

    let debugUrl: string | undefined;
    const debugAt = Date.now();
    try {
      const debug = await this.client.sessions.debug(session.id);
      debugUrl = debug.debuggerFullscreenUrl;
      logInfo("browserbase", "debug-link.end", {
        sessionId: session.id,
        durationMs: elapsedMs(debugAt),
      });
    } catch (error) {
      logWarn("browserbase", "debug-link.unavailable", {
        sessionId: session.id,
        durationMs: elapsedMs(debugAt),
        error: error instanceof Error ? error.message : String(error),
      });
      // Collection still works if a debug URL cannot be created.
    }

    logInfo("browserbase", "collector.start.end", {
      sessionId: session.id,
      sources: browserSources.join(","),
      durationMs: elapsedMs(startAt),
    });

    return {
      mode: "browserbase",
      searchMode,
      sessionId: session.id,
      sessionUrl: `https://browserbase.com/sessions/${session.id}`,
      debugUrl,
    };
  }

  async collect(): Promise<SocialPost[]> {
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
        logInfo("browserbase", "extract.end", {
          collectionId,
          source,
          posts: extracted.length,
          durationMs: elapsedMs(extractionAt),
          sourceTotalMs: elapsedMs(sourceAt),
        });
        return extracted;
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

  async stop(): Promise<void> {
    this.pages.clear();
    this.hasCollectedLoadedPages = false;
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
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
