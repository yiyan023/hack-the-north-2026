export type SearchMode = "live" | "historical";
// Reddit support disabled.
export type BrowserSource = "x";

const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const HISTORICAL_HINT_PATTERN = /\b(?:historical|classic|throwback|replay)\b/i;
const QUERY_CONNECTORS = new Set(["vs", "versus"]);

export function classifySearchMode(query: string): SearchMode {
  return classifySearchModeAtYear(query, new Date().getUTCFullYear());
}

export function classifySearchModeAtYear(
  query: string,
  currentYear: number,
): SearchMode {
  const years = query.match(new RegExp(YEAR_PATTERN.source, "g")) ?? [];
  const referencesPastYear = years.some((year) => Number(year) < currentYear);
  return referencesPastYear || HISTORICAL_HINT_PATTERN.test(query)
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
    params.set("f", mode === "historical" ? "top" : "live");
    return `https://x.com/search?${params.toString()}`;
  }

  // Reddit support disabled.
  throw new Error("Reddit support is disabled.");
}

export function buildSearchQuery(query: string): string {
  const clean = query
    .replaceAll('"', "")
    .replace(/\bvs\.?\b|\bversus\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const patterns = [
    /\bworld\s+cup(?:\s+finals?)?\b/i,
    /\bchampions\s+league\b/i,
    /\b(?:nba|wnba|nfl|nhl|mlb)\s+finals?\b/i,
    /\b[\p{L}'-]+\s+(?:championships?|tournament|masters|open)\b/iu,
  ];
  const phrase = patterns
    .map((pattern) => clean.match(pattern)?.[0])
    .find(Boolean);
  if (!phrase) return normalizeSearchQuery(clean);

  const remainder = normalizeSearchQuery(clean.replace(phrase, " "));
  return [remainder, `"${phrase}"`].filter(Boolean).join(" ");
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
