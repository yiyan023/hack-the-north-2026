export type SearchMode = "live" | "historical";
export type BrowserSource = "x" | "reddit";

const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const HISTORICAL_HINT_PATTERN = /\b(?:historical|classic|throwback|replay)\b/i;
const QUERY_CONNECTORS = new Set(["vs", "versus"]);

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
  const searchQuery = normalizeSearchQuery(query);
  if (source === "x") {
    const params = new URLSearchParams({ q: searchQuery, src: "typed_query" });
    if (mode === "historical") params.set("f", "top");
    return `https://x.com/search?${params.toString()}`;
  }

  const params = new URLSearchParams({
    q: searchQuery,
    sort: mode === "historical" ? "relevance" : "new",
    t: mode === "historical" ? "all" : "day",
  });
  return `https://www.reddit.com/search/?${params.toString()}`;
}

export function normalizeSearchQuery(query: string): string {
  return [...new Set(
    query
      .replaceAll('"', "")
      .replace(/\bvs\.?\b|\bversus\b/gi, " ")
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 0 && !QUERY_CONNECTORS.has(term.toLowerCase())),
  )]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .join(" ");
}
