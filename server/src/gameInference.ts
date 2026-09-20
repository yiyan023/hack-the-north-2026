import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config.js";

const inferenceSchema = z.object({
  game: z.string().trim().min(2).max(120),
});

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    game: {
      type: "string",
      description: "The specific sports game or event being discussed, in a concise form.",
    },
  },
  required: ["game"],
} as const;

export async function inferGame(messages: string[]): Promise<{ game: string; mode: "gemini" | "local" }> {
  const transcript = messages.join("\n").slice(-2_000);
  if (config.geminiApiKey) {
    try {
      const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const interaction = await client.interactions.create({
        model: config.geminiModel,
        input: [
          "Infer the specific sports game or event discussed in this group chat.",
          "Use only details present in the messages. Prefer teams, player, competition, and year when available.",
          "Do not include commentary or uncertainty. Return a concise searchable topic.",
          `Chat messages:\n${transcript}`,
        ].join("\n\n"),
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: responseSchema,
        },
      });
      if (interaction.output_text) {
        const parsed = inferenceSchema.parse(JSON.parse(interaction.output_text));
        return { game: parsed.game, mode: "gemini" };
      }
    } catch {
      // Fall through to a deterministic local guess when inference is unavailable.
    }
  }

  return { game: localGuess(transcript), mode: "local" };
}

function localGuess(transcript: string): string {
  const matchup = transcript.match(/([^\n]{2,60}?)\s+(?:vs\.?|versus|v\.)\s+([^\n]{2,60})/i);
  const left = matchup?.[1]?.trim();
  const right = matchup?.[2]?.trim();
  if (left && right) return `${left} vs ${right}`.slice(0, 120);

  const line = transcript
    .split("\n")
    .map((value) => value.trim())
    .find((value) => /\b(?:game|match|final|cup|league|f1|formula 1|nba|nfl|nhl|mlb|goal|score)\b/i.test(value));
  return (line || transcript.split("\n")[0] || "Sports game").slice(0, 120);
}