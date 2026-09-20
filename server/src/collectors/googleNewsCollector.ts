import { XMLParser } from "fast-xml-parser";
import { classifySearchMode, normalizeSearchQuery } from "../searchMode.js";
import type {
  Collector,
  CollectorDetails,
  SocialPost,
  Source,
} from "../types.js";

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  guid?: string | { "#text"?: string };
  source?: string | { "#text"?: string };
};

export class GoogleNewsCollector implements Collector {
  private query = "";
  private searchMode: "live" | "historical" = "live";
  private readonly parser = new XMLParser({ ignoreAttributes: false });

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async start(query: string, _sources: Source[]): Promise<CollectorDetails> {
    this.query = query;
    this.searchMode = classifySearchMode(query);
    return { mode: "google-news", searchMode: this.searchMode };
  }

  async collect(): Promise<SocialPost[]> {
    const query = buildNewsQuery(this.query, this.searchMode);
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "en-CA");
    url.searchParams.set("gl", "CA");
    url.searchParams.set("ceid", "CA:en");

    const response = await this.fetcher(url, {
      headers: { "user-agent": "iknowball-hackathon/0.1" },
    });
    if (!response.ok) {
      throw new Error(`Google News returned ${response.status} ${response.statusText}`);
    }

    const parsed = this.parser.parse(await response.text());
    const rawItems = parsed?.rss?.channel?.item as RssItem[] | RssItem | undefined;
    const items = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];
    const collectedAt = new Date().toISOString();

    const minimumRelevance = Math.min(2, queryTokens(this.query).length);
    const orderedItems = [...items]
      .filter((item) => relevance(textValue(item.title), this.query) >= minimumRelevance)
      .sort((left, right) => {
        const qualityDifference = quality(textValue(right.title), this.query) - quality(textValue(left.title), this.query);
        if (qualityDifference !== 0) return qualityDifference;
        return Date.parse(right.pubDate || "") - Date.parse(left.pubDate || "");
      });

    return orderedItems.slice(0, 30).flatMap((item, rank) => {
      const title = textValue(item.title);
      const link = textValue(item.link);
      if (!title || !link) return [];
      const source = textValue(item.source) || "Google News";
      const guid = textValue(item.guid) || link;
      return [{
        id: `news:${guid}`,
        source: "news" as const,
        author: source,
        text: title,
        url: link,
        publishedAt: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : collectedAt,
        collectedAt,
        rank,
      } satisfies SocialPost];
    });
  }

  async stop(): Promise<void> {}
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

function buildNewsQuery(query: string, mode: "live" | "historical") {
  const clean = normalizeSearchQuery(query);
  return mode === "historical" ? clean : `${clean} when:30d`;
}

function relevance(title: string, query: string) {
  const normalizedTitle = title.toLowerCase();
  return queryTokens(query).reduce(
    (score, token) => score + (tokenMatches(normalizedTitle, token) ? 1 : 0),
    0,
  );
}

function tokenMatches(title: string, token: string) {
  if (title.includes(token)) return true;
  const aliases: Record<string, string[]> = {
    cavaliers: ["cavs", "cleveland"],
    warriors: ["golden state"],
    tottenham: ["spurs"],
  };
  return aliases[token]?.some((alias) => title.includes(alias)) ?? false;
}

function queryTokens(query: string) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !["the", "final", "finals"].includes(token));
}

function quality(title: string, query: string) {
  const useful = /\b(?:win|winner|score|goal|fires|recap|highlights|reaction|thriller|defeat|beats?|edge|draw)\b/i.test(title)
    ? 3
    : 0;
  const promotional = /\b(?:how to watch|live stream|tv channel|broadcast|odds|regarder|prediction)\b/i.test(title)
    ? 4
    : 0;
  return relevance(title, query) * 10 + useful - promotional;
}
