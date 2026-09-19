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
      (source): source is Exclude<Source, "news"> => source !== "news",
    );
    if (browserSources.length === 0) {
      throw new Error("Select X or Reddit before starting Browserbase.");
    }
    let session;
    try {
      session = await this.client.sessions.create(
        this.contextId
          ? {
              browserSettings: {
                context: {
                  id: this.contextId,
                  // Collection is read-only. Do not let a transient logout or
                  // verification challenge overwrite the known-good login.
                  persist: false,
                },
              },
            }
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/401|unauthorized/i.test(message)) {
        throw new Error(
          "Browserbase rejected BROWSERBASE_API_KEY (401). Add a current Dashboard API key to .env.",
        );
      }
      throw error;
    }
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
      if (source === "x") {
        await this.waitForXResults(page);
      }
      this.pages.set(source, page);
    }

    let debugUrl: string | undefined;
    try {
      const debug = await this.client.sessions.debug(session.id);
      debugUrl = debug.debuggerFullscreenUrl;
    } catch {
      // Collection still works if a debug URL cannot be created.
    }

    return {
      mode: "browserbase",
      searchMode,
      sessionId: session.id,
      debugUrl,
    };
  }

  async collect(): Promise<SocialPost[]> {
    const results = await Promise.allSettled(
      [...this.pages.entries()].map(async ([source, page]) => {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        if (source === "x") {
          await this.waitForXResults(page);
        }
        return source === "x"
          ? this.extractXPosts(page)
          : this.extractRedditPosts(page);
      }),
    );

    return results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  }

  async stop(): Promise<void> {
    this.pages.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }

  private async extractXPosts(page: Page): Promise<SocialPost[]> {
    return page.locator("article").evaluateAll((articles) => {
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
  }

  private async waitForXResults(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (/\/login|\/onboarding\/|mode=login/i.test(currentUrl)) {
      throw new Error(
        "X is not logged in inside the Browserbase context. Complete one manual X login in a persist:true Browserbase session, close it, and wait a few seconds before retrying.",
      );
    }

    // X renders search results after DOMContentLoaded. Waiting on the actual
    // result element prevents an otherwise healthy pull from racing the UI.
    await page.locator("article").first().waitFor({
      state: "attached",
      timeout: 10_000,
    });
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
