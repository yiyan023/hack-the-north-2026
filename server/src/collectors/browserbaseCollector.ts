import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import type {
  Collector,
  CollectorDetails,
  SocialPost,
  Source,
} from "../types.js";

export class BrowserbaseCollector implements Collector {
  private readonly client: Browserbase;
  private browser?: Browser;
  private pages = new Map<Source, Page>();

  constructor(apiKey: string) {
    this.client = new Browserbase({ apiKey });
  }

  async start(query: string, sources: Source[]): Promise<CollectorDetails> {
    const session = await this.client.sessions.create();
    this.browser = await chromium.connectOverCDP(session.connectUrl);

    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Browserbase returned no browser context");

    const existingPage = context.pages()[0];
    for (const [index, source] of sources.entries()) {
      const page = index === 0 && existingPage ? existingPage : await context.newPage();
      await page.goto(this.searchUrl(source, query), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.pages.set(source, page);
    }

    let debugUrl: string | undefined;
    try {
      const debug = await this.client.sessions.debug(session.id);
      debugUrl = debug.debuggerFullscreenUrl;
    } catch {
      // Collection still works if a debug URL cannot be created.
    }

    return { mode: "browserbase", sessionId: session.id, debugUrl };
  }

  async collect(): Promise<SocialPost[]> {
    const results = await Promise.allSettled(
      [...this.pages.entries()].map(async ([source, page]) => {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
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

  private searchUrl(source: Source, query: string): string {
    const encoded = encodeURIComponent(query);
    if (source === "x") {
      return `https://x.com/search?q=${encoded}&src=typed_query&f=live`;
    }
    return `https://www.reddit.com/search/?q=${encoded}&sort=new&t=hour`;
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
