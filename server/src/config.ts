import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveEnvPath(): string {
  const cwdPath = path.resolve(process.cwd(), ".env");
  if (existsSync(cwdPath)) return cwdPath;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  return cwdPath;
}

export const envPath = resolveEnvPath();
dotenv.config({ path: envPath });

function integer(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function maskSecret(value: string): string {
  if (!value) return "(empty)";
  return `set (****${value.slice(-4)}, ${value.length} chars)`;
}

export const config = {
  envPath,
  port: integer("PORT", 3000),
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? "",
  browserbaseContextId: process.env.BROWSERBASE_CONTEXT_ID ?? "",
  syntheticFeedEnabled: process.env.ENABLE_TEST_FEED === "true",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  pollIntervalMs: integer("POLL_INTERVAL_MS", 12_000),
  bufferSize: integer("BUFFER_SIZE", 100),
  postsPerBatch: integer("POSTS_PER_BATCH", 10),
  maxPostsPerGeneration: integer("MAX_POSTS_PER_GENERATION", 30),
  geminiConcurrency: integer("GEMINI_CONCURRENCY", 3),
  geminiMinIntervalMs: integer("GEMINI_MIN_INTERVAL_MS", 20_000),
  minNewPosts: integer("MIN_NEW_POSTS", 5),
  suggestionMaxAgeMs: integer("SUGGESTION_MAX_AGE_MS", 45_000),
  sentimentRefreshIntervalMs: integer("SENTIMENT_REFRESH_INTERVAL_MS", 60_000),
  sentimentChangeThreshold: Number.parseFloat(process.env.SENTIMENT_CHANGE_THRESHOLD ?? "0.35") || 0.35,
};
