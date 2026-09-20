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
          source: "x",
          author: "viewer",
          text: "Huge save from the goalkeeper",
          url: "https://x.com/viewer/status/1",
          publishedAt: "2026-09-20T00:00:00.000Z",
          collectedAt: "2026-09-20T00:00:01.000Z",
        },
      ],
      toneExamples: [],
      replyTo: "",
    });

    expect(result.suggestions).toHaveLength(3);
    expect(mocks.createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.5-flash-lite",
        generation_config: { thinking_level: "minimal" },
      }),
    );
  });
});
