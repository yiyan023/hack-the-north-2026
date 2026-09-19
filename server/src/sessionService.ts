import { config } from "./config.js";
import { BrowserbaseCollector } from "./collectors/browserbaseCollector.js";
import { DemoCollector } from "./collectors/demoCollector.js";
import { DemoGenerator } from "./generators/demoGenerator.js";
import { GeminiGenerator } from "./generators/geminiGenerator.js";
import { RollingPostBuffer } from "./rollingBuffer.js";
import { SuggestionPipeline } from "./suggestionPipeline.js";
import type {
  Collector,
  CollectorDetails,
  Source,
  SuggestionDeck,
  SuggestionGenerator,
} from "./types.js";

type Status = "idle" | "starting" | "collecting" | "stopped" | "error";

export class SessionService {
  private status: Status = "idle";
  private game = "";
  private toneExamples: string[] = [];
  private sources: Source[] = [];
  private collector?: Collector;
  private details?: CollectorDetails;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private lastPollAt?: string;
  private lastError?: string;
  private readonly buffer = new RollingPostBuffer(config.bufferSize);
  private pipeline?: SuggestionPipeline;

  async start(input: {
    game: string;
    sources: Source[];
    toneExamples: string[];
  }) {
    await this.stop();
    this.status = "starting";
    this.game = input.game;
    this.sources = input.sources;
    this.toneExamples = input.toneExamples;
    this.buffer.clear();
    this.lastError = undefined;

    const useDemoCollector = config.forceDemoMode || !config.browserbaseApiKey;
    const useDemoGenerator = config.forceDemoMode || !config.geminiApiKey;
    this.collector = useDemoCollector
      ? new DemoCollector()
      : new BrowserbaseCollector(config.browserbaseApiKey);
    const generator: SuggestionGenerator = useDemoGenerator
      ? new DemoGenerator()
      : new GeminiGenerator(config.geminiApiKey, config.geminiModel);

    this.pipeline = new SuggestionPipeline(
      this.buffer,
      generator,
      () => ({ game: this.game, toneExamples: this.toneExamples }),
      {
        postsPerBatch: config.postsPerBatch,
        maxPosts: config.maxPostsPerGeneration,
        concurrency: config.geminiConcurrency,
        minIntervalMs: config.geminiMinIntervalMs,
        minNewPosts: config.minNewPosts,
        maxAgeMs: config.suggestionMaxAgeMs,
      },
    );

    try {
      this.details = await this.collector.start(this.game, this.sources);
      this.status = "collecting";
      await this.pollOnce();
      this.timer = setInterval(() => void this.pollOnce(), config.pollIntervalMs);
      return this.snapshot();
    } catch (error) {
      this.status = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.collector.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.collector?.stop().catch(() => undefined);
    this.collector = undefined;
    this.polling = false;
    if (this.status !== "idle") this.status = "stopped";
    return this.snapshot();
  }

  async suggestions(): Promise<SuggestionDeck | undefined> {
    if (!this.pipeline) return undefined;
    const cached = this.pipeline.latest;
    if (cached) {
      if (this.pipeline.isStale()) void this.pipeline.request(false);
      return cached;
    }
    return this.pipeline.request(true);
  }

  async refresh(): Promise<SuggestionDeck | undefined> {
    return this.pipeline?.request(true);
  }

  snapshot() {
    return {
      status: this.status,
      game: this.game,
      sources: this.sources,
      collectorMode: this.details?.mode,
      generatorMode: this.pipeline?.latest?.mode ??
        (config.forceDemoMode || !config.geminiApiKey ? "demo" : "gemini"),
      browserbaseSessionId: this.details?.sessionId,
      browserbaseDebugUrl: this.details?.debugUrl,
      postCount: this.buffer.size,
      bufferVersion: this.buffer.version,
      generationRunning: this.pipeline?.isRunning ?? false,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      pollIntervalMs: config.pollIntervalMs,
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || !this.collector) return;
    this.polling = true;
    try {
      const posts = await this.collector.collect();
      const added = this.buffer.add(posts);
      this.lastPollAt = new Date().toISOString();
      this.lastError = undefined;
      if (added > 0) void this.pipeline?.request(false);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("Poll failed", error);
    } finally {
      this.polling = false;
    }
  }
}
