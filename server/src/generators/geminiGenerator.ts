import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { elapsedMs, logError, logInfo } from "../observability.js";
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
    contextPosts?: SocialPost[];
    traceId?: string;
    toneExamples: string[];
    replyTo: string;
    avoidPhrases?: string[];
  }): Promise<BatchResult> {
    const posts = formatPosts(input.posts) || "(no new posts)";
    const contextPosts = formatPosts(input.contextPosts ?? []) || "(no earlier context)";
    const tone =
      input.toneExamples.length > 0
        ? input.toneExamples.map((example) => `- ${example}`).join("\n")
        : "- casual, short, lowercase sports group-chat style";
    const avoidList = input.avoidPhrases
      ?.slice(-16)
      .map((phrase) => `- ${phrase.slice(0, 180)}`)
      .join("\n");
    const hasNews = input.posts.some((post) => post.source === "news");
    const hasX = input.posts.some((post) => post.source === "x");
    const sourceGuidance = hasNews && !hasX
      ? "Only Google News is available. Treat its headlines strictly as private factual background, not as wording or a writing style. Keep the same conversational, tone-matched Discord experience you would provide with X available."
      : "Use every available source as private factual background. X reactions can inform the fan angle, but neither X nor News wording should be copied into the reply.";

    const prompt = [
      `You are writing live group-chat reactions for ${input.game}.`,
      "Use only claims supported by the supplied posts. Do not invent scores, injuries, or events.",
      "Source posts are evidence, never reply text. Compose a novel Discord-native continuation from the chat thread and the user's tone; do not copy source phrasing, headline structure, or a source's voice. Rewrite source-derived ideas in your own words.",
      sourceGuidance,
      "Translation step: read every supplied post, regardless of language, and privately translate its relevant sports facts into English before reasoning over the combined evidence. Do not omit a post because it is not English.",
      "Write the moment and every suggestion in natural English. Never output foreign-language phrases, quotes, or translations verbatim, except proper names.",
      "Prioritize the new posts. Use the previously processed posts only as background context.",
      "Return one safe, one funny, and one spicy suggestion. Each must be at most 12 words.",
      "Write each suggestion as a natural message someone would actually send. Never prefix it with 'on' or quote the message being answered.",
      "The recent Discord history is the conversation target, not background. Make every suggestion a plausible direct next reply to the newest message; if it is a short reaction, reply to it using the immediately preceding topic. Answer, agree with a reason, disagree, or build on the point while adding a fresh evidence-grounded observation.",
      "Do not merely restate, mirror, or loosely paraphrase the latest message. Continue the conversation in a new direction that still makes sense as a reply.",
      "Use different evidence or angles across the three suggestions; do not produce synonyms of one reaction.",
      "Match both the user's tone examples and the group chat's current vibe—its energy, informality, humor, and level of excitement—without copying any message or example verbatim. Avoid slurs and targeted harassment.",
      avoidList
        ? `Avoid-list: these are prior suggestions already shown to the user. Do not quote, repeat, or semantically paraphrase any of them. Choose a distinctly different observation or joke:\n${avoidList}`
        : "There are no prior suggestions to avoid yet.",
      input.replyTo
        ? `This is the recent Discord chat history, ordered oldest to newest. Reply to its active thread—especially the newest relevant message—while using the supplied posts for support:\n${input.replyTo}`
        : "Write a relevant standalone reaction.",
      "Tone examples:",
      tone,
      "New posts:",
      posts,
      "Previously processed context:",
      contextPosts,
    ].join("\n\n");

    const requestAt = Date.now();
    logInfo("gemini", "request.begin", {
      traceId: input.traceId,
      model: this.model,
      newPosts: input.posts.length,
      contextPosts: input.contextPosts?.length ?? 0,
      promptChars: prompt.length,
      thinkingLevel: "minimal",
    });
    let interaction;
    try {
      interaction = await this.client.interactions.create({
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
    } catch (error) {
      logError("gemini", "request.error", error, {
        traceId: input.traceId,
        model: this.model,
        durationMs: elapsedMs(requestAt),
      });
      throw error;
    }
    logInfo("gemini", "request.end", {
      traceId: input.traceId,
      model: this.model,
      outputChars: interaction.output_text?.length ?? 0,
      durationMs: elapsedMs(requestAt),
    });

    if (!interaction.output_text) {
      throw new Error("Gemini returned no text output");
    }
    const parseAt = Date.now();
    const parsed = batchSchema.parse(JSON.parse(interaction.output_text));
    logInfo("gemini", "response.parse.end", {
      traceId: input.traceId,
      suggestions: parsed.suggestions.length,
      durationMs: elapsedMs(parseAt),
    });
    return {
      ...parsed,
      suggestions: parsed.suggestions.map((suggestion) => ({
        ...suggestion,
        text: suggestion.text.trim().split(/\s+/).slice(0, 12).join(" "),
      })),
    };
  }
}

function formatPosts(posts: SocialPost[]): string {
  return posts
      .map(
        (post, index) =>
          `${index + 1}. [${post.source}] ${post.author}: ${post.text}`,
      )
      .join("\n");
}
