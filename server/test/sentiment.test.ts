import { describe, expect, it } from "vitest";
import { aggregateSentiment, isMajorSentimentChange } from "../src/sentiment.js";
import type { SocialPost } from "../src/types.js";

function post(text: string): SocialPost {
  return {
    id: text,
    source: "test",
    author: "test",
    text,
    url: "https://example.com",
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  };
}

describe("sentiment refresh", () => {
  it("detects a major shift in aggregate post sentiment", () => {
    const positive = aggregateSentiment([post("incredible goal, brilliant win")]);
    const negative = aggregateSentiment([post("terrible collapse, awful mistake")]);
    expect(positive).toBeGreaterThan(0);
    expect(negative).toBeLessThan(0);
    expect(isMajorSentimentChange(positive, negative, 0.35)).toBe(true);
  });

  it("does not refresh for a small shift", () => {
    expect(isMajorSentimentChange(0.1, 0.3, 0.35)).toBe(false);
  });
});