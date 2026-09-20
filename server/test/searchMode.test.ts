import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  buildSearchQuery,
  classifySearchMode,
  classifySearchModeAtYear,
  normalizeSearchQuery,
} from "../src/searchMode.js";

describe("search modes", () => {
  it("uses live feeds for an undated game", () => {
    expect(classifySearchMode("Arsenal vs Chelsea")).toBe("live");
    expect(buildSearchUrl("x", "Arsenal vs Chelsea")).toContain("f=live");
  });

  it("treats the current or a future year as live, not historical", () => {
    expect(classifySearchModeAtYear("2026 badminton championships", 2026)).toBe("live");
    expect(classifySearchModeAtYear("2027 badminton championships", 2026)).toBe("live");
    expect(classifySearchModeAtYear("2020 badminton championships", 2026)).toBe("historical");
  });

  it("keeps competition phrases together to avoid mixing unrelated events", () => {
    expect(buildSearchQuery("2026 badminton championships")).toBe(
      '2026 "badminton championships"',
    );
    expect(buildSearchQuery("Argentina vs France 2022 World Cup Final")).toBe(
      '2022 Argentina France "World Cup Final"',
    );
  });

  it("uses broad relevance search for a historical game", () => {
    const query = "Argentina vs France 2022 World Cup Final";
    expect(classifySearchMode(query)).toBe("historical");
    expect(buildSearchUrl("x", query)).toContain("f=top");
  });

  it("normalizes reordered matchup wording to the same search", () => {
    expect(normalizeSearchQuery("f1 madrid 2026 vs 2026 f1 madrid")).toBe(
      normalizeSearchQuery("2026 f1 madrid vs f1 madrid 2026"),
    );
    expect(buildSearchUrl("x", "f1 madrid 2026 vs 2026 f1 madrid")).toBe(
      buildSearchUrl("x", "2026 f1 madrid vs f1 madrid 2026"),
    );
  });
});
