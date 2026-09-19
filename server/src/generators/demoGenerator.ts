import type {
  BatchResult,
  SocialPost,
  SuggestionGenerator,
} from "../types.js";

export class DemoGenerator implements SuggestionGenerator {
  readonly mode = "demo" as const;

  async generateBatch(input: {
    game: string;
    posts: SocialPost[];
    toneExamples: string[];
  }): Promise<BatchResult> {
    const subject = input.posts[0]?.text.split(/[.!?]/)[0] ?? input.game;
    return {
      moment: subject.slice(0, 140),
      confidence: 0.72,
      suggestions: [
        { style: "safe", text: "They need to settle down and keep the ball" },
        { style: "funny", text: "Bro is treating possession like a hot potato" },
        { style: "spicy", text: "Get him off before he creates another counterattack" },
      ],
    };
  }
}
