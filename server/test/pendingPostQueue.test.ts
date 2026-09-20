import { describe, expect, it } from "vitest";
import { PendingPostQueue } from "../src/pendingPostQueue.js";
import type { SocialPost } from "../src/types.js";

function post(id: string, text = `post ${id}`): SocialPost {
  return {
    id,
    source: "x",
    author: "fan",
    text,
    url: `https://example.com/${id}`,
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  };
}

describe("PendingPostQueue", () => {
  it("deduplicates by post id and normalized text", () => {
    const queue = new PendingPostQueue(20);

    expect(
      queue.add([
        post("one", "Huge save!"),
        post("one", "Huge save!"),
        post("two", "huge   save"),
        post("three", "Different observation"),
      ]),
    ).toBe(2);
    expect(queue.pendingSize).toBe(2);
    expect(queue.version).toBe(2);
  });

  it("moves posts through pending, in-flight, and acknowledged states", () => {
    const queue = new PendingPostQueue(20);
    queue.add([post("one"), post("two")]);

    const claimed = queue.claim(1);
    expect(queue.pendingSize).toBe(1);
    expect(queue.inFlightSize).toBe(1);

    expect(queue.acknowledge(claimed).map((item) => item.id)).toEqual(["one"]);
    expect(queue.pendingSize).toBe(1);
    expect(queue.inFlightSize).toBe(0);
  });

  it("returns failed posts to pending without treating them as new", () => {
    const queue = new PendingPostQueue(20);
    queue.add([post("one"), post("two")]);
    const claimed = queue.claim(2);

    queue.retry(claimed);

    expect(queue.pendingSize).toBe(2);
    expect(queue.inFlightSize).toBe(0);
    expect(queue.version).toBe(2);
  });
});
