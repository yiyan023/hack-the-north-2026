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
  SocialPost,
  Source,
  SuggestionDeck,
  SuggestionGenerator,
  ThinkingMode,
} from "./types.js";

type Status = "idle" | "starting" | "collecting" | "stopped" | "error";
type SourceState = "idle" | "starting" | "ready" | "error";
type SourceStatus = { state: SourceState; postCount: number; error?: string };

function emptySourceStatuses(): Record<Source, SourceStatus> {
  return {
    x: { state: "idle", postCount: 0 },
    news: { state: "idle", postCount: 0 },
    test: { state: "idle", postCount: 0 },
  };
}

export class SessionService {
  private status: Status = "idle";
  private game = "";
  private toneExamples: string[] = [];
  private replyTo = "";
  private sources: Source[] = [];
  private thinkingMode: ThinkingMode = "medium";
  private collectors = new Map<Source, Collector>();
  private generator?: SuggestionGenerator;
  private details?: CollectorDetails;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private pollQueued = false;
  private runId = 0;
  private sourceStatuses = emptySourceStatuses();
  private lastPollAt?: string;
  private lastPollAdded = 0;
  private lastSentimentCheckAt = 0;
  private sentimentBaseline?: number;
  private lastError?: string;
  private sessionRunId = "idle";
  private pollSequence = 0;
  private readonly pendingQueue = new PendingPostQueue(config.bufferSize);
  private readonly recentContext = new RollingPostBuffer(config.bufferSize);
  private readonly browserbaseCollector?: BrowserbaseCollector;
  private pipeline?: SuggestionPipeline;

  constructor(browserbaseCollector?: BrowserbaseCollector) {
    this.browserbaseCollector = browserbaseCollector ?? (
      config.browserbaseApiKey
        ? new BrowserbaseCollector(
            config.browserbaseApiKey,
            config.browserbaseContextId,
          )
        : undefined
    );
  }

  async prewarmBrowserbase(): Promise<{
    ready: boolean;
    reason?: string;
    sessionId?: string;
    sessionUrl?: string;
    debugUrl?: string;
  }> {
    if (!this.browserbaseCollector) {
      return { ready: false, reason: "BROWSERBASE_API_KEY is not configured" };
    }
    try {
      const details = await this.browserbaseCollector.prewarm();
      return { ready: true, ...details };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logError("session", "browserbase.prewarm.error", error);
      return { ready: false, reason: this.lastError };
    }
  }

  async shutdown() {
    await this.stop();
    await this.browserbaseCollector?.shutdown();
  }

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
    this.collectors.clear();
    this.sourceStatuses = emptySourceStatuses();
    this.lastPollAdded = 0;
    this.lastSentimentCheckAt = 0;
    this.sentimentBaseline = undefined;
    this.lastError = undefined;

    const onlySynthetic = this.sources.every((source) => source === "test");
    if (this.sources.includes("test") && !onlySynthetic) {
      throw new Error("The synthetic test feed must be selected by itself.");
    }
    if (onlySynthetic && !config.syntheticFeedEnabled) {
      throw new Error("Synthetic test feed is disabled. Set ENABLE_TEST_FEED=true for local testing.");
    }
    if (this.sources.includes("x") && !config.browserbaseContextId) {
      throw new Error("X requires BROWSERBASE_CONTEXT_ID so a manual login can persist in Browserbase.");
    }
    if (this.sources.includes("x") && !config.browserbaseApiKey) {
      throw new Error("X requires BROWSERBASE_API_KEY. Select Public news for the keyless real-data path.");
    }

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
      const runId = ++this.runId;
      const collectors = this.createCollectors(onlySynthetic);
      await Promise.any(
        collectors.map(({ source, collector }) => this.startCollector(runId, source, collector)),
      );
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
      await Promise.allSettled([...this.collectors.values()].map((collector) => collector.stop()));
      this.collectors.clear();
      throw error;
    }
  }

  async stop() {
    this.pipeline?.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.runId += 1;
    await Promise.allSettled([...this.collectors.values()].map((collector) => collector.stop()));
    this.collectors.clear();
    this.polling = false;
    this.pollQueued = false;
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
    const maximum = Math.min(Math.max(1, limit), 50);
    // News ranks ahead of X in the rolling buffer, so returning a plain slice
    // can make the evidence panel look News-only. Interleave sources here so
    // the panel represents every enabled source as soon as it has results.
    return interleaveEvidence(this.allPosts(), maximum);
  }

  snapshot() {
    const allPosts = this.allPosts();
    const warmBrowser = this.browserbaseCollector?.snapshot();
    return {
      status: this.status,
      game: this.game,
      sources: this.sources,
      collectorMode: this.collectors.size > 1 ? "multi-source" : this.details?.mode,
      searchMode: this.details?.searchMode,
      generatorMode: this.pipeline?.latest?.mode ?? this.generator?.mode,
      browserbaseReady: warmBrowser?.ready ?? false,
      browserbaseActive: warmBrowser?.active ?? false,
      browserbaseSessionId: this.details?.sessionId ?? warmBrowser?.sessionId,
      browserbaseSessionUrl: this.details?.sessionUrl ?? warmBrowser?.sessionUrl,
      browserbaseDebugUrl: this.details?.debugUrl ?? warmBrowser?.debugUrl,
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
        { x: 0, news: 0, test: 0 },
      ),
      sourceStatuses: this.sourceStatuses,
      lastError: this.lastError ?? this.pipeline?.lastError,
      providerWarning: this.generator?.lastError
        ? `Gemini is unavailable; using local fallback suggestions. ${this.generator.lastError}`
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
    if (this.polling) {
      this.pollQueued = true;
      return;
    }
    if (this.collectors.size === 0) return;
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
      const results = await Promise.allSettled(
        [...this.collectors.entries()].map(async ([source, collector]) => ({
          source,
          posts: await collector.collect(),
        })),
      );
      const collectorDurationMs = elapsedMs(collectAt);
      const sources = [...this.collectors.keys()];
      const posts = results.flatMap((result, index) => {
        if (result.status === "fulfilled") {
          const status = this.sourceStatuses[result.value.source];
          status.state = "ready";
          status.postCount += result.value.posts.length;
          status.error = undefined;
          return result.value.posts;
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        const source = sources[index];
        if (source) this.sourceStatuses[source] = { ...this.sourceStatuses[source], state: "error", error: message };
        return [];
      });
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
      if (this.pollQueued) {
        this.pollQueued = false;
        void this.pollOnce();
      }
    }
  }

  private createCollectors(onlySynthetic: boolean): Array<{ source: Source; collector: Collector }> {
    if (onlySynthetic) return [{ source: "test", collector: new SyntheticCollector() }];
    const collectors: Array<{ source: Source; collector: Collector }> = [];
    if (this.sources.includes("x")) {
      if (!this.browserbaseCollector) {
        throw new Error("Browserbase is not configured.");
      }
      collectors.push({
        source: "x",
        collector: this.browserbaseCollector,
      });
    }
    if (this.sources.includes("news")) collectors.push({ source: "news", collector: new GoogleNewsCollector() });
    return collectors;
  }

  private async startCollector(runId: number, source: Source, collector: Collector): Promise<void> {
    this.sourceStatuses[source] = { state: "starting", postCount: 0 };
    let details: CollectorDetails;
    try {
      details = await collector.start(this.game, [source]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sourceStatuses[source] = { state: "error", postCount: 0, error: message };
      throw error;
    }
    if (runId !== this.runId) {
      await collector.stop().catch(() => undefined);
      return;
    }
    this.collectors.set(source, collector);
    this.sourceStatuses[source] = { state: "ready", postCount: 0 };
    if (source === "x" || !this.details) this.details = details;
    console.log(`[session] ${source} collector ready mode=${details.mode} session=${details.sessionId ?? "none"}`);
    if (this.status === "collecting") void this.pollOnce();
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

function interleaveEvidence(posts: SocialPost[], maximum: number) {
  const queues = new Map<Source, SocialPost[]>();
  for (const source of ["x", "news", "test"] as const) queues.set(source, []);
  for (const post of posts) queues.get(post.source)?.push(post);

  const mixed: SocialPost[] = [];
  while (mixed.length < maximum) {
    let added = false;
    for (const source of ["x", "news", "test"] as const) {
      const post = queues.get(source)?.shift();
      if (!post) continue;
      mixed.push(post);
      added = true;
      if (mixed.length === maximum) break;
    }
    if (!added) break;
  }
  return mixed;
}
