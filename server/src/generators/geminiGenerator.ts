import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type {
  BatchResult,
  SocialPost,
  SuggestionGenerator,
} from "../types.js";

const batchSchema = z.object({
  moment: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  suggestions: z
    .array(
      z.object({
        style: z.enum(["safe", "funny", "spicy"]),
        text: z.string().min(1).max(120),
      }),
    )
    .length(3),
});

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    moment: {
      type: "string",
      description: "One short description of the current game conversation.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          style: { type: "string", enum: ["safe", "funny", "spicy"] },
          text: {
            type: "string",
            description: "A punchy group-chat message of at most 12 words.",
          },
        },
        required: ["style", "text"],
      },
    },
  },
  required: ["moment", "confidence", "suggestions"],
} as const;

export class GeminiGenerator implements SuggestionGenerator {
  readonly mode = "gemini" as const;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateBatch(input: {
    game: string;
    posts: SocialPost[];
    toneExamples: string[];
    replyTo: string;
  }): Promise<BatchResult> {
    const posts = input.posts
      .map(
        (post, index) =>
          `${index + 1}. [${post.source}] ${post.author}: ${post.text}`,
      )
      .join("\n");
    const tone =
      input.toneExamples.length > 0
        ? input.toneExamples.map((example) => `- ${example}`).join("\n")
        : "- casual, short, lowercase sports group-chat style";

    const prompt = [
      `You are writing live group-chat reactions for ${input.game}.`,
      "Use only claims supported by the supplied posts. Do not invent scores, injuries, or events.",
      "Return one safe, one funny, and one spicy suggestion. Each must be at most 12 words.",
      "Write each suggestion as a natural message someone would actually send. Never prefix it with 'on', quote the message being answered, or restate that message.",
      "Match the user's tone without copying an example verbatim. Avoid slurs and targeted harassment.",
      input.replyTo
        ? `This is the recent Discord chat history. Treat it as primary conversational context. Respond to the latest relevant message, not just the sports evidence, and make the suggestion feel like a natural continuation of this chat:\n${input.replyTo}`
        : "Write a relevant standalone reaction.",
      "Tone examples:",
      tone,
      "Recent posts:",
      posts,
    ].join("\n\n");

    const interaction = await this.client.interactions.create({
      model: this.model,
      input: prompt,
      generation_config: {
        // These are short, grounded chat suggestions, so minimize reasoning
        // latency rather than spending tokens on deeper deliberation.
        thinking_level: "minimal",
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: responseSchema,
      },
    });

    if (!interaction.output_text) {
      throw new Error("Gemini returned no text output");
    }
    const parsed = batchSchema.parse(JSON.parse(interaction.output_text));
    return {
      ...parsed,
      suggestions: parsed.suggestions.map((suggestion) => ({
        ...suggestion,
        text: suggestion.text.trim().split(/\s+/).slice(0, 12).join(" "),
      })),
    };
  }
}
