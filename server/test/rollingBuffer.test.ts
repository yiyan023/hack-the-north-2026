import { describe, expect, it } from "vitest";
import { RollingPostBuffer } from "../src/rollingBuffer.js";
import type { SocialPost } from "../src/types.js";

function post(id: string, secondsAgo = 0): SocialPost {
  const timestamp = new Date(Date.now() - secondsAgo * 1_000).toISOString();
  return {
    id,
    source: "x",
    author: "fan",
    text: `post ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: timestamp,
    collectedAt: timestamp,
  };
}

describe("RollingPostBuffer", () => {
  it("deduplicates posts and keeps only the newest entries", () => {
    const buffer = new RollingPostBuffer(2);
    expect(buffer.add([post("old", 20), post("new", 1)])).toBe(2);
    expect(buffer.add([post("new", 1), post("newest", 0)])).toBe(1);

    expect(buffer.latest(10).map((item) => item.id)).toEqual(["newest", "new"]);
    expect(buffer.version).toBe(3);
  });
});
