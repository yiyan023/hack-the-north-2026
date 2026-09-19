import "dotenv/config";

function integer(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export const config = {
  port: integer("PORT", 3000),
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
  pollIntervalMs: integer("POLL_INTERVAL_MS", 12_000),
  bufferSize: integer("BUFFER_SIZE", 100),
  postsPerBatch: integer("POSTS_PER_BATCH", 10),
  maxPostsPerGeneration: integer("MAX_POSTS_PER_GENERATION", 30),
  geminiConcurrency: integer("GEMINI_CONCURRENCY", 3),
  geminiMinIntervalMs: integer("GEMINI_MIN_INTERVAL_MS", 20_000),
  minNewPosts: integer("MIN_NEW_POSTS", 5),
  suggestionMaxAgeMs: integer("SUGGESTION_MAX_AGE_MS", 45_000),
  forceDemoMode: bool("FORCE_DEMO_MODE", false),
};
