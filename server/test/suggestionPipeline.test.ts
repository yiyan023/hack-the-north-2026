import { describe, expect, it, vi } from "vitest";
import { PendingPostQueue } from "../src/pendingPostQueue.js";
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

  it("batches ten posts and runs batches concurrently", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(25));
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
      queue,
      recentContext,
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
        contextPosts: 3,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes.sort((a, b) => b - a)).toEqual([10, 10, 5]);
    expect(maxActive).toBe(3);
    expect(deck?.suggestions).toHaveLength(3);
    expect(deck?.thinkingMode).toBe("deep");
    expect(deck?.sourcePostCount).toBe(25);
    expect(queue.pendingSize).toBe(0);
    expect(queue.inFlightSize).toBe(0);
    expect(recentContext.size).toBe(25);
  });

  it("sends only two posts to Gemini in fast mode", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(25));
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
      queue,
      recentContext,
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
        contextPosts: 3,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes).toEqual([2]);
    expect(deck?.sourcePostCount).toBe(2);
    expect(deck?.thinkingMode).toBe("fast");
    expect(queue.pendingSize).toBe(23);
    pipeline.stop();
  });

  it("sends ten posts to Gemini in medium mode", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(25));
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
      queue,
      recentContext,
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
        contextPosts: 3,
      },
    );

    const deck = await pipeline.request();
    expect(batchSizes).toEqual([10]);
    expect(deck?.sourcePostCount).toBe(10);
    expect(deck?.thinkingMode).toBe("medium");
    expect(queue.pendingSize).toBe(15);
    pipeline.stop();
  });

  it("does not resend processed posts as new work", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(2));
    const calls: Array<{ posts: string[]; context: string[] }> = [];

    const generator: SuggestionGenerator = {
      mode: "gemini",
      async generateBatch(input) {
        calls.push({
          posts: input.posts.map((post) => post.id),
          context: (input.contextPosts ?? []).map((post) => post.id),
        });
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
      queue,
      recentContext,
      generator,
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
      {
        thinkingMode: "fast",
        postsPerBatch: 2,
        maxPosts: 2,
        concurrency: 1,
        minIntervalMs: 1,
        minNewPosts: 1,
        maxAgeMs: 1,
        contextPosts: 2,
      },
    );

    await pipeline.request(true);
    queue.add([posts(3)[2]!]);
    await pipeline.request(true);

    expect(calls).toEqual([
      { posts: ["x:0", "x:1"], context: [] },
      { posts: ["x:2"], context: ["x:0", "x:1"] },
    ]);
    expect(queue.pendingSize).toBe(0);
    expect(recentContext.size).toBe(3);
  });

  it("returns claimed posts to pending when generation fails", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(2));
    const generator: SuggestionGenerator = {
      mode: "gemini",
      async generateBatch() {
        throw new Error("temporary provider failure");
      },
    };

    const pipeline = new SuggestionPipeline(
      queue,
      recentContext,
      generator,
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
      {
        thinkingMode: "fast",
        postsPerBatch: 2,
        maxPosts: 2,
        concurrency: 1,
        minIntervalMs: 1,
        minNewPosts: 1,
        maxAgeMs: 1,
        contextPosts: 2,
      },
    );

    await pipeline.request(true);

    expect(queue.pendingSize).toBe(2);
    expect(queue.inFlightSize).toBe(0);
    expect(recentContext.size).toBe(0);
  });

  it("automatically processes posts that arrive during an in-flight request", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(2));
    const calls: string[][] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const generator: SuggestionGenerator = {
      mode: "gemini",
      async generateBatch(input) {
        calls.push(input.posts.map((post) => post.id));
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
        }
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
      queue,
      recentContext,
      generator,
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
      {
        thinkingMode: "fast",
        postsPerBatch: 2,
        maxPosts: 2,
        concurrency: 1,
        minIntervalMs: 0,
        minNewPosts: 1,
        maxAgeMs: 1,
        contextPosts: 2,
      },
    );

    const firstRequest = pipeline.request(true);
    await firstStarted;
    queue.add([posts(3)[2]!]);
    void pipeline.request(false);
    releaseFirst();
    await firstRequest;

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([["x:0", "x:1"], ["x:2"]]);
    expect(queue.pendingSize).toBe(0);
    expect(queue.inFlightSize).toBe(0);
    expect(recentContext.size).toBe(3);
    pipeline.stop();
  });

  it("lets repeated readers join an in-flight request without generating twice", async () => {
    const queue = new PendingPostQueue(100);
    const recentContext = new RollingPostBuffer(100);
    queue.add(posts(2));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const generator: SuggestionGenerator = {
      mode: "gemini",
      async generateBatch() {
        calls += 1;
        await gate;
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
      queue,
      recentContext,
      generator,
      () => ({ game: "test game", toneExamples: [], replyTo: "" }),
      {
        thinkingMode: "fast",
        postsPerBatch: 2,
        maxPosts: 2,
        concurrency: 1,
        minIntervalMs: 0,
        minNewPosts: 1,
        maxAgeMs: 1,
        contextPosts: 2,
      },
    );

    const first = pipeline.request(true);
    const joined = pipeline.request(true);
    release();
    await Promise.all([first, joined]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toBe(1);
    expect(queue.pendingSize).toBe(0);
    pipeline.stop();
  });
});
