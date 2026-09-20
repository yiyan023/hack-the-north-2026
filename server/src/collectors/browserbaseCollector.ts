import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
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

  constructor(apiKey: string, contextId = "") {
    this.client = new Browserbase({ apiKey });
    this.contextId = contextId;
  }

  async start(query: string, sources: Source[]): Promise<CollectorDetails> {
    const searchMode = classifySearchMode(query);
    const browserSources = sources.filter(
      (source): source is "x" | "reddit" => source === "x" || source === "reddit",
    );
    if (browserSources.length === 0) {
      throw new Error("Select X or Reddit before starting Browserbase.");
    }
    console.log(
      `[browserbase] creating session query="${query}" sources=${browserSources.join(",")} context=${this.contextId ? "configured" : "missing"} persist=false`,
    );
    let session;
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
      console.error(`[browserbase] session creation failed: ${message}`);
      if (/401|unauthorized/i.test(message)) {
        throw new Error(
          "Browserbase rejected BROWSERBASE_API_KEY (401). Add a current Dashboard API key to .env.",
        );
      }
      throw error;
    }
    console.log(`[browserbase] session created id=${session.id}`);
    this.browser = await chromium.connectOverCDP(session.connectUrl);

    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Browserbase returned no browser context");

    const existingPage = context.pages()[0];
    for (const [index, source] of browserSources.entries()) {
      const page = index === 0 && existingPage ? existingPage : await context.newPage();
      await page.goto(buildSearchUrl(source, query, searchMode), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      console.log(`[browserbase] navigated source=${source} url=${page.url()}`);
      this.pages.set(source, page);
    }

    let debugUrl: string | undefined;
    try {
      const debug = await this.client.sessions.debug(session.id);
      debugUrl = debug.debuggerFullscreenUrl;
      console.log(`[browserbase] debug link ready session=${session.id}`);
    } catch {
      console.warn(`[browserbase] debug link unavailable session=${session.id}`);
      // Collection still works if a debug URL cannot be created.
    }

    return {
      mode: "browserbase",
      searchMode,
      sessionId: session.id,
      sessionUrl: `https://browserbase.com/sessions/${session.id}`,
      debugUrl,
    };
  }

  async collect(): Promise<SocialPost[]> {
    console.log(`[browserbase] poll started sources=${[...this.pages.keys()].join(",")}`);
    const results = await Promise.allSettled(
      [...this.pages.entries()].map(async ([source, page]) => {
        console.log(`[browserbase] reloading source=${source} url=${page.url()}`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        console.log(`[browserbase] loaded source=${source} url=${page.url()} title="${await page.title()}"`);
        if (source === "x") {
          await this.waitForXResults(page);
        }
        const posts = source === "x"
          ? this.extractXPosts(page)
          : this.extractRedditPosts(page);
        const extracted = await posts;
        console.log(`[browserbase] extracted source=${source} posts=${extracted.length}`);
        return extracted;
      }),
    );

    return results.flatMap((result, index) => {
      const source = [...this.pages.keys()][index] ?? "unknown";
      if (result.status === "fulfilled") return result.value;
      console.error(`[browserbase] poll failed source=${source}: ${formatError(result.reason)}`);
      return [];
    });
  }

  async stop(): Promise<void> {
    this.pages.clear();
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
    const currentUrl = page.url();
    console.log(`[browserbase] X check url=${currentUrl}`);
    if (/\/login|\/onboarding\/|mode=login/i.test(currentUrl)) {
      console.error("[browserbase] X is showing a login/onboarding page; context cookies are not authenticated");
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
      console.error(
        `[browserbase] X result timeout url=${page.url()} title="${await page.title()}" body="${bodyText}"`,
      );
      throw error;
    }
    const articleCount = await page.locator("article").count();
    const tweetCount = await page.locator('[data-testid="tweetText"]').count();
    console.log(`[browserbase] X results detected articles=${articleCount} tweetTexts=${tweetCount}`);
  }

  private async extractRedditPosts(page: Page): Promise<SocialPost[]> {
    return page.locator("shreddit-post, article").evaluateAll((elements) => {
      const collectedAt = new Date().toISOString();
      return elements
        .map((element, index) => {
          const title =
            element
              .querySelector<HTMLElement>('a[data-testid="post-title"]')
              ?.innerText.trim() ||
            element.querySelector<HTMLElement>("h1, h2, h3")?.innerText.trim();
          const body = element
            .querySelector<HTMLElement>('[slot="text-body"], [data-post-click-location="text-body"]')
            ?.innerText.trim();
          const link = element.querySelector<HTMLAnchorElement>('a[href*="/comments/"]');
          const href = link?.getAttribute("href");
          const postId = element.getAttribute("id") || element.getAttribute("thingid");
          if (!title || !href) return null;

          const url = new URL(href, "https://www.reddit.com").toString();
          return {
            id: `reddit:${postId || url || index}`,
            source: "reddit" as const,
            author: element.getAttribute("author") || "unknown",
            text: body ? `${title}\n${body}` : title,
            url,
            publishedAt: element.getAttribute("created-timestamp") || collectedAt,
            collectedAt,
          };
        })
        .filter((post): post is NonNullable<typeof post> => post !== null);
    });
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
