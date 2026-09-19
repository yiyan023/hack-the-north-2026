import { describe, expect, it } from "vitest";
import { buildSearchUrl, classifySearchMode } from "../src/searchMode.js";

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
});
