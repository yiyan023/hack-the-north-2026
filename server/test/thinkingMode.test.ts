import { describe, expect, it } from "vitest";
import {
  pipelineLimitsForThinkingMode,
  postsForThinkingMode,
} from "../src/thinkingMode.js";

describe("thinking modes", () => {
  it("maps fast, medium, and deep thinking to Gemini post counts", () => {
    expect(postsForThinkingMode("fast")).toBe(2);
    expect(postsForThinkingMode("medium")).toBe(10);
    expect(postsForThinkingMode("deep")).toBe(30);
  });

  it("caps batch size and min-new-posts to the selected mode", () => {
    expect(
      pipelineLimitsForThinkingMode("fast", { postsPerBatch: 10, minNewPosts: 5 }),
    ).toEqual({
      thinkingMode: "fast",
      maxPosts: 2,
      postsPerBatch: 2,
      minNewPosts: 2,
    });

    expect(
      pipelineLimitsForThinkingMode("medium", { postsPerBatch: 10, minNewPosts: 5 }),
    ).toEqual({
      thinkingMode: "medium",
      maxPosts: 10,
      postsPerBatch: 10,
      minNewPosts: 5,
    });

    expect(
      pipelineLimitsForThinkingMode("deep", { postsPerBatch: 10, minNewPosts: 5 }),
    ).toEqual({
      thinkingMode: "deep",
      maxPosts: 30,
      postsPerBatch: 10,
      minNewPosts: 5,
    });
  });
});
