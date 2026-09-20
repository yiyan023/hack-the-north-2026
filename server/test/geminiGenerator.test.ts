import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInteraction: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: mocks.createInteraction };
  },
}));

import { GeminiGenerator } from "../src/generators/geminiGenerator.js";

describe("GeminiGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createInteraction.mockResolvedValue({
      output_text: JSON.stringify({
        moment: "A goalkeeper just made an important save.",
        confidence: 0.9,
        suggestions: [
          { style: "safe", text: "that save was massive" },
          { style: "funny", text: "bro installed a force field" },
          { style: "spicy", text: "striker is seeing that save in his nightmares" },
        ],
      }),
    });
  });

  it("requests minimal Gemini thinking for low-latency suggestions", async () => {
    const generator = new GeminiGenerator("api-key", "gemini-3.5-flash-lite");

    const result = await generator.generateBatch({
      game: "World Cup",
      posts: [
        {
          id: "x:1",
          source: "news",
          author: "viewer",
          text: "Huge save from the goalkeeper",
          url: "https://x.com/viewer/status/1",
          publishedAt: "2026-09-20T00:00:00.000Z",
          collectedAt: "2026-09-20T00:00:01.000Z",
        },
      ],
      toneExamples: [],
      replyTo: "do you think Max can catch him?\nMcLaren looks ridiculous today",
      avoidPhrases: ["that save was massive"],
    });

    expect(result.suggestions).toHaveLength(3);
    expect(mocks.createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.5-flash-lite",
        generation_config: { thinking_level: "minimal" },
      }),
    );
    const request = mocks.createInteraction.mock.calls[0]?.[0] as { input: string };
    expect(request.input).toContain("regardless of language");
    expect(request.input).toContain("every suggestion in natural English");
    expect(request.input).toContain("conversation target");
    expect(request.input).toContain("plausible direct next reply");
    expect(request.input).toContain("Max can catch him");
    expect(request.input).toContain("Avoid-list");
    expect(request.input).toContain("that save was massive");
    expect(request.input).toContain("Source posts are evidence, never reply text");
    expect(request.input).toContain("Rewrite source-derived ideas in your own words");
    expect(request.input).toContain("direct next reply to the newest message");
    expect(request.input).toContain("group chat's current vibe");
    expect(request.input).toContain("Only Google News is available");
    expect(request.input).toContain("same conversational, tone-matched Discord experience");
  });
});
