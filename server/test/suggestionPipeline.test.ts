import { describe, expect, it } from "vitest";
import { RollingPostBuffer } from "../src/rollingBuffer.js";
import { SuggestionPipeline } from "../src/suggestionPipeline.js";
import type { SocialPost, SuggestionGenerator } from "../src/types.js";

function posts(count: number): SocialPost[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `x:${index}`,
    source: "x" as const,
    author: "fan",
    text: `observation ${index}`,
    url: `https://example.com/${index}`,
    publishedAt: new Date(Date.now() - index).toISOString(),
    collectedAt: new Date().toISOString(),
  }));
}

describe("SuggestionPipeline", () => {
  it("batches ten posts and runs batches concurrently", async () => {
    const buffer = new RollingPostBuffer(100);
    buffer.add(posts(25));
    let active = 0;
    let maxActive = 0;
    const batchSizes: number[] = [];

    const generator: SuggestionGenerator = {
      mode: "demo",
      async generateBatch(input) {
        batchSizes.push(input.posts.length);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          moment: "test moment",
          confidence: 0.8,
          suggestions: [
            { style: "safe", text: "safe message" },
            { style: "funny", text: "funny message" },
            { style: "spicy", text: "spicy message" },
          ],
        };
      },
    };

    const pipeline = new SuggestionPipeline(
      buffer,
      generator,
      () => ({ game: "test game", toneExamples: [] }),
      {
        thinkingMode: "deep",
        postsPerBatch: 10,
        maxPosts: 30,
        concurrency: 3,
        minIntervalMs: 1,
        minNewPosts: 5,
        maxAgeMs: 1,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes.sort((a, b) => b - a)).toEqual([10, 10, 5]);
    expect(maxActive).toBe(3);
    expect(deck?.suggestions).toHaveLength(3);
    expect(deck?.thinkingMode).toBe("deep");
    expect(deck?.sourcePostCount).toBe(25);
  });

  it("sends only two posts to Gemini in fast mode", async () => {
    const buffer = new RollingPostBuffer(100);
    buffer.add(posts(25));
    const batchSizes: number[] = [];

    const generator: SuggestionGenerator = {
      mode: "demo",
      async generateBatch(input) {
        batchSizes.push(input.posts.length);
        return {
          moment: "fast moment",
          confidence: 0.7,
          suggestions: [
            { style: "safe", text: "safe message" },
            { style: "funny", text: "funny message" },
            { style: "spicy", text: "spicy message" },
          ],
        };
      },
    };

    const pipeline = new SuggestionPipeline(
      buffer,
      generator,
      () => ({ game: "test game", toneExamples: [] }),
      {
        thinkingMode: "fast",
        postsPerBatch: 2,
        maxPosts: 2,
        concurrency: 3,
        minIntervalMs: 1,
        minNewPosts: 2,
        maxAgeMs: 1,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes).toEqual([2]);
    expect(deck?.sourcePostCount).toBe(2);
    expect(deck?.thinkingMode).toBe("fast");
  });
});
