import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  classifySearchMode,
  normalizeSearchQuery,
} from "../src/searchMode.js";

describe("search modes", () => {
  it("uses live feeds for an undated game", () => {
    expect(classifySearchMode("Arsenal vs Chelsea")).toBe("live");
    expect(buildSearchUrl("x", "Arsenal vs Chelsea")).toContain("f=live");
    expect(buildSearchUrl("reddit", "Arsenal vs Chelsea")).toContain("sort=new");
  });

  it("uses broad relevance search for a historical game", () => {
    const query = "Argentina vs France 2022 World Cup Final";
    expect(classifySearchMode(query)).toBe("historical");
    expect(buildSearchUrl("x", query)).toContain("f=top");
    expect(buildSearchUrl("reddit", query)).toContain("sort=relevance");
    expect(buildSearchUrl("reddit", query)).toContain("t=all");
  });

  it("normalizes reordered matchup wording to the same search", () => {
    expect(normalizeSearchQuery("f1 madrid 2026 vs 2026 f1 madrid")).toBe(
      normalizeSearchQuery("2026 f1 madrid vs f1 madrid 2026"),
    );
    expect(buildSearchUrl("reddit", "f1 madrid 2026 vs 2026 f1 madrid")).toBe(
      buildSearchUrl("reddit", "2026 f1 madrid vs f1 madrid 2026"),
    );
  });
});
