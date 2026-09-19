export type SearchMode = "live" | "historical";
export type BrowserSource = "x" | "reddit";

const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const HISTORICAL_HINT_PATTERN = /\b(?:historical|classic|throwback|replay)\b/i;

export function classifySearchMode(query: string): SearchMode {
  return YEAR_PATTERN.test(query) || HISTORICAL_HINT_PATTERN.test(query)
    ? "historical"
    : "live";
}

export function buildSearchUrl(
  source: BrowserSource,
  query: string,
  mode = classifySearchMode(query),
): string {
  if (source === "x") {
    const params = new URLSearchParams({
      q: query,
      src: "typed_query",
      f: mode === "historical" ? "top" : "live",
    });
    return `https://x.com/search?${params.toString()}`;
  }

  const params = new URLSearchParams({
    q: query,
    sort: mode === "historical" ? "relevance" : "new",
    t: mode === "historical" ? "all" : "day",
  });
  return `https://www.reddit.com/search/?${params.toString()}`;
}
