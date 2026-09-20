import { describe, expect, it } from "vitest";
import { RollingPostBuffer } from "../src/rollingBuffer.js";
import { SuggestionPipeline, testing } from "../src/suggestionPipeline.js";
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
  it("removes trailing periods from final suggestions", async () => {
    const { pickSuggestions } = testing;
    const suggestions = pickSuggestions([{
      moment: "test",
      confidence: 1,
      suggestions: [
        { style: "safe", text: "that was wild." },
        { style: "funny", text: "bro no way..." },
        { style: "spicy", text: "someone check on them" },
      ],
    }]);

    expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
      "that was wild",
      "bro no way",
      "someone check on them",
    ]);
  });

  it("skips suggestions that repeat a recent chat phrase", () => {
    const { pickSuggestions } = testing;
    const suggestions = pickSuggestions([{
      moment: "test",
      confidence: 1,
      suggestions: [
        { style: "safe", text: "their defense is completely cooked tonight" },
        { style: "safe", text: "that back line is getting exposed" },
        { style: "funny", text: "someone unplugged the defending controller" },
        { style: "spicy", text: "the defenders need a group project meeting" },
      ],
    }], ["their defense is completely cooked tonight"]);

    expect(suggestions.find((suggestion) => suggestion.style === "safe")?.text).toBe(
      "that back line is getting exposed",
    );
    expect(suggestions).toHaveLength(3);
  });

  it("balances sources and rotates to unseen evidence on refresh", () => {
    const { selectDiversePosts } = testing;
    const mixed = [
      ...posts(4),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...posts(1)[0]!,
        id: `news:${index}`,
        source: "news" as const,
        text: `news observation ${index}`,
      })),
    ];
    const used = new Set<string>();

    const first = selectDiversePosts(mixed, 4, used);
    for (const post of first) used.add(post.id);
    const second = selectDiversePosts(mixed, 4, used);

    expect(first.map((post) => post.source)).toEqual(["x", "news", "x", "news"]);
    expect(second.map((post) => post.source)).toEqual(["x", "news", "x", "news"]);
    expect(second.every((post) => !first.some((firstPost) => firstPost.id === post.id))).toBe(true);
  });

  it("batches ten posts and runs batches concurrently", async () => {
    const buffer = new RollingPostBuffer(100);
    buffer.add(posts(25));
    let active = 0;
    let maxActive = 0;
    const batchSizes: number[] = [];

    const generator: SuggestionGenerator = {
      mode: "gemini",
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
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
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
      mode: "gemini",
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
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
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

  it("sends ten posts to Gemini in medium mode", async () => {
    const buffer = new RollingPostBuffer(100);
    buffer.add(posts(25));
    const batchSizes: number[] = [];

    const generator: SuggestionGenerator = {
      mode: "gemini",
      async generateBatch(input) {
        batchSizes.push(input.posts.length);
        return {
          moment: "medium moment",
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
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
      {
        thinkingMode: "medium",
        postsPerBatch: 10,
        maxPosts: 10,
        concurrency: 3,
        minIntervalMs: 1,
        minNewPosts: 5,
        maxAgeMs: 1,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes).toEqual([10]);
    expect(deck?.sourcePostCount).toBe(10);
    expect(deck?.thinkingMode).toBe("medium");
  });
});
