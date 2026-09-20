import { config } from "../server/src/config.js";
import { SessionService } from "../server/src/sessionService.js";

const defaultGames = [
  "World Cup",
  "Arsenal Chelsea",
  "Argentina France 2022 World Cup final",
];

const games = process.env.BENCHMARK_GAMES
  ? process.env.BENCHMARK_GAMES.split("|").map((game) => game.trim()).filter(Boolean)
  : defaultGames;

type Result = {
  game: string;
  browserbaseSessionId?: string;
  searchMode?: string;
  postCount: number;
  generatorMode?: string;
  suggestionCount: number;
  startMs: number;
  suggestionMs: number;
  totalMs: number;
};

async function benchmarkGame(service: SessionService, game: string): Promise<Result> {
  try {
    const startAt = performance.now();
    const session = await service.start({
      game,
      sources: ["x"],
      toneExamples: ["we are so back"],
      replyTo: "holy this goalie",
      thinkingMode: "fast",
    });
    const collectedAt = performance.now();

    const deck = await service.suggestions();
    const completedAt = performance.now();
    const result: Result = {
      game,
      browserbaseSessionId: session.browserbaseSessionId,
      searchMode: session.searchMode,
      postCount: service.posts(50).length,
      generatorMode: deck?.mode,
      suggestionCount: deck?.suggestions.length ?? 0,
      startMs: Math.round(collectedAt - startAt),
      suggestionMs: Math.round(completedAt - collectedAt),
      totalMs: Math.round(completedAt - startAt),
    };

    if (result.postCount === 0) {
      throw new Error(`${game}: Browserbase returned no X posts.`);
    }
    if (result.generatorMode !== "gemini" || result.suggestionCount !== 3) {
      throw new Error(
        `${game}: expected three Gemini suggestions, received ${result.suggestionCount} from ${result.generatorMode ?? "no generator"}.`,
      );
    }

    return result;
  } finally {
    await service.stop();
  }
}

async function main() {
  if (!config.browserbaseApiKey || !config.browserbaseContextId || !config.geminiApiKey) {
    throw new Error(
      "The latency E2E test requires BROWSERBASE_API_KEY, BROWSERBASE_CONTEXT_ID, and GEMINI_API_KEY.",
    );
  }

  const service = new SessionService();
  const results: Result[] = [];
  let prewarmMs = 0;
  try {
    const prewarmAt = performance.now();
    const prewarm = await service.prewarmBrowserbase();
    prewarmMs = Math.round(performance.now() - prewarmAt);
    if (!prewarm.ready) {
      throw new Error(`Browserbase prewarm failed: ${prewarm.reason}`);
    }

    for (const game of games) {
      results.push(await benchmarkGame(service, game));
    }
  } finally {
    await service.shutdown();
  }

  const sessionIds = new Set(
    results.map((result) => result.browserbaseSessionId).filter(Boolean),
  );
  const sessionReused = sessionIds.size === 1 && results.length > 0;
  if (!sessionReused) {
    throw new Error("Expected every game to reuse one Browserbase session.");
  }

  const averageTotalMs = Math.round(
    results.reduce((sum, result) => sum + result.totalMs, 0) / results.length,
  );
  const report = {
    label: process.env.BENCHMARK_LABEL ?? "current",
    model: config.geminiModel,
    thinkingMode: "fast",
    prewarmMs,
    sessionReused,
    results,
    averageTotalMs,
  };

  console.table(results);
  console.log(`Browserbase prewarm: ${prewarmMs} ms; one session reused: ${sessionReused}`);
  console.log(`E2E_BENCHMARK_JSON=${JSON.stringify(report)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
