import { config } from "./config.js";
import { BrowserbaseCollector } from "./collectors/browserbaseCollector.js";
import { GoogleNewsCollector } from "./collectors/googleNewsCollector.js";
import { SyntheticCollector } from "./collectors/syntheticCollector.js";
import { EvidenceGenerator } from "./generators/evidenceGenerator.js";
import { GeminiGenerator } from "./generators/geminiGenerator.js";
import { ResilientGenerator } from "./generators/resilientGenerator.js";
import { PendingPostQueue } from "./pendingPostQueue.js";
import { RollingPostBuffer } from "./rollingBuffer.js";
import { elapsedMs, logError, logInfo } from "./observability.js";
import { SuggestionPipeline } from "./suggestionPipeline.js";
import { pipelineLimitsForThinkingMode } from "./thinkingMode.js";
import { aggregateSentiment, isMajorSentimentChange } from "./sentiment.js";
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
  private lastSentimentCheckAt = 0;
  private sentimentBaseline?: number;
  private lastError?: string;
  private sessionRunId = "idle";
  private pollSequence = 0;
  private readonly pendingQueue = new PendingPostQueue(config.bufferSize);
  private readonly recentContext = new RollingPostBuffer(config.bufferSize);
  private pipeline?: SuggestionPipeline;

  async start(input: {
    game: string;
    sources: Source[];
    toneExamples: string[];
    replyTo: string;
    thinkingMode: ThinkingMode;
  }) {
    const startAt = Date.now();
    await this.stop();
    this.sessionRunId = crypto.randomUUID().slice(0, 8);
    this.pollSequence = 0;
    logInfo("session", "start.begin", {
      runId: this.sessionRunId,
      game: input.game,
      sources: input.sources.join(","),
      thinkingMode: input.thinkingMode,
    });
    this.status = "starting";
    this.game = input.game;
    this.sources = input.sources;
    this.toneExamples = input.toneExamples;
    this.replyTo = input.replyTo;
    this.thinkingMode = input.thinkingMode;
    this.pendingQueue.clear();
    this.recentContext.clear();
    this.details = undefined;
    this.lastPollAdded = 0;
    this.lastSentimentCheckAt = 0;
    this.sentimentBaseline = undefined;
    this.lastError = undefined;

    const onlySynthetic = this.sources.every((source) => source === "test");
    const onlyPublicNews = this.sources.every((source) => source === "news");
    if (this.sources.includes("test") && !onlySynthetic) {
      throw new Error("The synthetic test feed must be selected by itself.");
    }
    if (onlySynthetic && !config.syntheticFeedEnabled) {
      throw new Error("Synthetic test feed is disabled. Set ENABLE_TEST_FEED=true for local testing.");
    }
    if (this.sources.includes("x") && !config.browserbaseContextId) {
      throw new Error("X requires BROWSERBASE_CONTEXT_ID so a manual login can persist in Browserbase.");
    }
    if (!onlyPublicNews && !config.browserbaseApiKey) {
      throw new Error("X and Reddit require BROWSERBASE_API_KEY. Select Public news for the keyless real-data path.");
    }

    this.collector = onlySynthetic
      ? new SyntheticCollector()
      : onlyPublicNews
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
      this.pendingQueue,
      this.recentContext,
      this.generator,
      () => ({
        game: this.game,
        toneExamples: this.toneExamples,
        replyTo: this.replyTo,
      }),
      {
        ...pipelineLimitsForThinkingMode(this.thinkingMode, {
          postsPerBatch: config.postsPerBatch,
          minNewPosts: onlySynthetic ? 1 : config.minNewPosts,
        }),
        concurrency: config.geminiConcurrency,
        minIntervalMs: onlySynthetic ? 0 : config.geminiMinIntervalMs,
        maxAgeMs: config.suggestionMaxAgeMs,
        contextPosts: config.geminiContextPosts,
      },
    );

    try {
      const collectorAt = Date.now();
      this.details = await this.collector.start(this.game, this.sources);
      logInfo("session", "collector.start.end", {
        runId: this.sessionRunId,
        mode: this.details.mode,
        sessionId: this.details.sessionId ?? "none",
        durationMs: elapsedMs(collectorAt),
      });
      this.status = "collecting";
      await this.pollOnce();
      this.timer = setInterval(() => void this.pollOnce(), config.pollIntervalMs);
      logInfo("session", "start.end", {
        runId: this.sessionRunId,
        pending: this.pendingQueue.pendingSize,
        inFlight: this.pendingQueue.inFlightSize,
        recent: this.recentContext.size,
        durationMs: elapsedMs(startAt),
      });
      return this.snapshot();
    } catch (error) {
      this.status = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      logError("session", "start.error", error, {
        runId: this.sessionRunId,
        durationMs: elapsedMs(startAt),
      });
      await this.collector.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop() {
    this.pipeline?.stop();
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
    return this.pipeline?.request(true, true);
  }

  async updateReplyContext(replyTo: string) {
    this.replyTo = replyTo;
    if (this.pipeline) void this.pipeline.request(true, true);
    return { ...this.snapshot(), contextUpdated: Boolean(this.pipeline) };
  }

  posts(limit = 12) {
    return this.allPosts().slice(0, Math.min(Math.max(1, limit), 50));
  }

  snapshot() {
    const allPosts = this.allPosts();
    return {
      status: this.status,
      game: this.game,
      sources: this.sources,
      collectorMode: this.details?.mode,
      searchMode: this.details?.searchMode,
      generatorMode: this.pipeline?.latest?.mode ?? this.generator?.mode,
      browserbaseSessionId: this.details?.sessionId,
      browserbaseSessionUrl: this.details?.sessionUrl,
      browserbaseDebugUrl: this.details?.debugUrl,
      postCount: allPosts.length,
      bufferVersion: this.pendingQueue.version,
      pendingPostCount: this.pendingQueue.pendingSize,
      inFlightPostCount: this.pendingQueue.inFlightSize,
      recentContextCount: this.recentContext.size,
      generationRunning: this.pipeline?.isRunning ?? false,
      lastPollAt: this.lastPollAt,
      lastPollAdded: this.lastPollAdded,
      sourceCounts: allPosts.reduce(
        (counts, post) => {
          counts[post.source] += 1;
          return counts;
        },
        { x: 0, reddit: 0, news: 0, test: 0 },
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
    const pollId = `${this.sessionRunId}:${++this.pollSequence}`;
    const startedAt = Date.now();
    logInfo("session", "poll.begin", {
      runId: this.sessionRunId,
      pollId,
      pending: this.pendingQueue.pendingSize,
      inFlight: this.pendingQueue.inFlightSize,
      recent: this.recentContext.size,
    });
    try {
      const collectAt = Date.now();
      const posts = await this.collector.collect();
      const collectorDurationMs = elapsedMs(collectAt);
      const queueAt = Date.now();
      const added = this.pendingQueue.add(posts);
      const queueDurationMs = elapsedMs(queueAt);
      this.lastPollAdded = added;
      this.lastPollAt = new Date().toISOString();
      if (posts.length > 0 || added > 0) this.lastError = undefined;
      logInfo("session", "poll.end", {
        runId: this.sessionRunId,
        pollId,
        posts: posts.length,
        added,
        pending: this.pendingQueue.pendingSize,
        inFlight: this.pendingQueue.inFlightSize,
        recent: this.recentContext.size,
        collectorDurationMs,
        queueDurationMs,
        durationMs: elapsedMs(startedAt),
      });
      if (added > 0) void this.pipeline?.request(false);
      this.checkSentiment(added > 0);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logError("session", "poll.error", error, {
        runId: this.sessionRunId,
        pollId,
        durationMs: elapsedMs(startedAt),
      });
    } finally {
      this.polling = false;
    }
  }

  private checkSentiment(hasNewPosts: boolean): void {
    if (!hasNewPosts || !this.pipeline) return;
    const now = Date.now();
    if (now - this.lastSentimentCheckAt < config.sentimentRefreshIntervalMs) return;

    const current = aggregateSentiment(this.allPosts());
    const previous = this.sentimentBaseline;
    this.lastSentimentCheckAt = now;
    this.sentimentBaseline = current;
    if (
      previous !== undefined &&
      isMajorSentimentChange(previous, current, config.sentimentChangeThreshold)
    ) {
      void this.pipeline.request(true, true);
    }
  }

  private allPosts() {
    const posts = [
      ...this.pendingQueue.pendingPosts(config.bufferSize),
      ...this.pendingQueue.inFlightPosts(),
      ...this.recentContext.latest(config.bufferSize),
    ];
    const unique = new Map(posts.map((post) => [post.id, post]));
    return [...unique.values()]
      .sort((a, b) => {
        if (a.rank !== undefined || b.rank !== undefined) {
          const rankDifference =
            (a.rank ?? Number.MAX_SAFE_INTEGER) -
            (b.rank ?? Number.MAX_SAFE_INTEGER);
          if (rankDifference !== 0) return rankDifference;
        }
        return (
          Date.parse(b.publishedAt || b.collectedAt) -
          Date.parse(a.publishedAt || a.collectedAt)
        );
      })
      .slice(0, config.bufferSize);
  }
}
