import { config } from "./config.js";
import { BrowserbaseCollector } from "./collectors/browserbaseCollector.js";
import { GoogleNewsCollector } from "./collectors/googleNewsCollector.js";
import { EvidenceGenerator } from "./generators/evidenceGenerator.js";
import { GeminiGenerator } from "./generators/geminiGenerator.js";
import { ResilientGenerator } from "./generators/resilientGenerator.js";
import { RollingPostBuffer } from "./rollingBuffer.js";
import { SuggestionPipeline } from "./suggestionPipeline.js";
import { pipelineLimitsForThinkingMode } from "./thinkingMode.js";
import type {
  Collector,
  CollectorDetails,
  Source,
  SuggestionDeck,
  SuggestionGenerator,
  ThinkingMode,
} from "./types.js";

type Status = "idle" | "starting" | "collecting" | "stopped" | "error";

export class SessionService {
  private status: Status = "idle";
  private game = "";
  private toneExamples: string[] = [];
  private replyTo = "";
  private sources: Source[] = [];
  private thinkingMode: ThinkingMode = "medium";
  private collector?: Collector;
  private generator?: SuggestionGenerator;
  private details?: CollectorDetails;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private lastPollAt?: string;
  private lastPollAdded = 0;
  private lastError?: string;
  private readonly buffer = new RollingPostBuffer(config.bufferSize);
  private pipeline?: SuggestionPipeline;

  async start(input: {
    game: string;
    sources: Source[];
    toneExamples: string[];
    replyTo: string;
    thinkingMode: ThinkingMode;
  }) {
    await this.stop();
    this.status = "starting";
    this.game = input.game;
    this.sources = input.sources;
    this.toneExamples = input.toneExamples;
    this.replyTo = input.replyTo;
    this.thinkingMode = input.thinkingMode;
    this.buffer.clear();
    this.details = undefined;
    this.lastPollAdded = 0;
    this.lastError = undefined;

    const onlyPublicNews = this.sources.every((source) => source === "news");
    if (!onlyPublicNews && !config.browserbaseApiKey) {
      throw new Error("X and Reddit require BROWSERBASE_API_KEY. Select Public news for the keyless real-data path.");
    }

    this.collector = onlyPublicNews
      ? new GoogleNewsCollector()
      : new BrowserbaseCollector(
          config.browserbaseApiKey,
          config.browserbaseContextId,
        );
    const localGenerator = new EvidenceGenerator();
    this.generator = config.geminiApiKey
      ? new ResilientGenerator(
          new GeminiGenerator(config.geminiApiKey, config.geminiModel),
          localGenerator,
        )
      : localGenerator;

    this.pipeline = new SuggestionPipeline(
      this.buffer,
      this.generator,
      () => ({
        game: this.game,
        toneExamples: this.toneExamples,
        replyTo: this.replyTo,
      }),
      {
        ...pipelineLimitsForThinkingMode(this.thinkingMode, {
          postsPerBatch: config.postsPerBatch,
          minNewPosts: config.minNewPosts,
        }),
        concurrency: config.geminiConcurrency,
        minIntervalMs: config.geminiMinIntervalMs,
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

  posts(limit = 12) {
    return this.buffer.latest(Math.min(Math.max(1, limit), 50));
  }

  snapshot() {
    return {
      status: this.status,
      game: this.game,
      sources: this.sources,
      collectorMode: this.details?.mode,
      searchMode: this.details?.searchMode,
      generatorMode: this.pipeline?.latest?.mode ?? this.generator?.mode,
      browserbaseSessionId: this.details?.sessionId,
      browserbaseDebugUrl: this.details?.debugUrl,
      postCount: this.buffer.size,
      bufferVersion: this.buffer.version,
      generationRunning: this.pipeline?.isRunning ?? false,
      lastPollAt: this.lastPollAt,
      lastPollAdded: this.lastPollAdded,
      sourceCounts: this.buffer.latest(config.bufferSize).reduce(
        (counts, post) => {
          counts[post.source] += 1;
          return counts;
        },
        { x: 0, reddit: 0, news: 0 },
      ),
      lastError: this.lastError ?? this.pipeline?.lastError,
      providerWarning: this.generator?.lastError
        ? "Gemini rejected its credential; using local copy grounded only in the displayed evidence."
        : undefined,
      pollIntervalMs: config.pollIntervalMs,
      thinkingMode: this.thinkingMode,
      maxPosts: pipelineLimitsForThinkingMode(this.thinkingMode, {
        postsPerBatch: config.postsPerBatch,
        minNewPosts: config.minNewPosts,
      }).maxPosts,
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || !this.collector) return;
    this.polling = true;
    try {
      const posts = await this.collector.collect();
      const added = this.buffer.add(posts);
      this.lastPollAdded = added;
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
