import type { PendingPostQueue } from "./pendingPostQueue.js";
import type { RollingPostBuffer } from "./rollingBuffer.js";
import { elapsedMs, logError, logInfo } from "./observability.js";
import type { ThinkingMode } from "./thinkingMode.js";
import type {
  BatchResult,
  SocialPost,
  SuggestionDeck,
  SuggestionGenerator,
  SuggestionStyle,
} from "./types.js";

interface PipelineOptions {
  thinkingMode: ThinkingMode;
  postsPerBatch: number;
  maxPosts: number;
  concurrency: number;
  minIntervalMs: number;
  minNewPosts: number;
  maxAgeMs: number;
  contextPosts: number;
}

export class SuggestionPipeline {
  private deck?: SuggestionDeck;
  private running?: Promise<SuggestionDeck | undefined>;
  private rerunForced = false;
  private lastAttemptAt = 0;
  private generationError?: string;
  private drainTimer?: NodeJS.Timeout;
  private stopped = false;
  private generationSequence = 0;
  private usedPostIds = new Set<string>();
  private recentSuggestionTexts: string[] = [];
  private drainTimer?: NodeJS.Timeout;
  private stopped = false;
  private generationSequence = 0;

  constructor(
    private readonly queue: PendingPostQueue,
    private readonly recentContext: RollingPostBuffer,
    private readonly generator: SuggestionGenerator,
    private readonly getContext: () => {
      game: string;
      toneExamples: string[];
      replyTo: string;
    },
    private readonly options: PipelineOptions,
  ) {}

  get latest(): SuggestionDeck | undefined {
    return this.deck;
  }

  get isRunning(): boolean {
    return Boolean(this.running);
  }

  get lastError(): string | undefined {
    return this.generationError;
  }

  isStale(now = Date.now()): boolean {
    if (!this.deck) return true;
    return now - Date.parse(this.deck.generatedAt) > this.options.maxAgeMs;
  }

  request(
    force = false,
    rerunIfBusy = false,
  ): Promise<SuggestionDeck | undefined> {
    if (this.stopped) return Promise.resolve(this.deck);
    if (this.running) {
      this.rerunForced ||= force && rerunIfBusy;
      return this.running;
    }

    if (!this.shouldGenerate(force)) return Promise.resolve(this.deck);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;

    this.running = this.generate(force)
      .catch((error) => {
        this.generationError = error instanceof Error ? error.message : String(error);
        logError("pipeline", "generation.error", error, {
          game: this.getContext().game,
          pending: this.queue.pendingSize,
          inFlight: this.queue.inFlightSize,
        });
        return this.deck;
      })
      .finally(() => {
        this.running = undefined;
        const rerunForced = this.rerunForced;
        this.rerunForced = false;
        if (this.stopped || this.generationError) return;

        if (rerunForced) {
          void this.request(true);
        } else if (this.queue.pendingSize > 0) {
          this.scheduleDrain();
        }
      });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }

  private shouldGenerate(force: boolean): boolean {
    if (force) {
      return this.queue.pendingSize > 0 || this.recentContext.size > 0;
    }
    if (this.queue.pendingSize === 0) return false;
    const now = Date.now();
    if (now - this.lastAttemptAt < this.options.minIntervalMs) {
      return false;
    }

    return (
      this.queue.pendingSize >= this.options.minNewPosts ||
      (this.queue.pendingSize > 0 && this.isStale(now))
    );
  }

  private async generate(force: boolean): Promise<SuggestionDeck | undefined> {
    const generationAt = Date.now();
    const generationId = `${++this.generationSequence}`;
    this.generationError = undefined;
    this.lastAttemptAt = Date.now();
    const version = this.queue.version;
    const claimed = this.queue.claim(this.options.maxPosts);
    const posts = selectDiversePosts(claimed, this.options.maxPosts, this.usedPostIds);
    const unused = claimed.filter((post) => !posts.some((selected) => selected.id === post.id));
    if (unused.length > 0) this.queue.retry(unused);
    const contextPosts = this.recentContext.latest(this.options.contextPosts);
    if (posts.length === 0 && (!force || contextPosts.length === 0)) {
      return this.deck;
    }

    const batches = posts.length > 0
      ? chunk(posts, this.options.postsPerBatch)
      : [[]];
    const context = this.getContext();
    // Chat history is a reply target. Only prior generated suggestions belong
    // on the avoid-list; otherwise the overlap guard rejects good replies that
    // deliberately engage with the conversation.
    const avoidPhrases = this.recentSuggestionTexts.slice(-24);
    const waits = posts.map((post) =>
      Math.max(0, Date.now() - Date.parse(post.collectedAt)),
    );
    logInfo("pipeline", "generation.begin", {
      generationId,
      game: context.game,
      force,
      newPosts: posts.length,
      contextPosts: contextPosts.length,
      batches: batches.length,
      pendingAfterClaim: this.queue.pendingSize,
      queueWaitOldestMs: waits.length > 0 ? Math.max(...waits) : 0,
      queueWaitNewestMs: waits.length > 0 ? Math.min(...waits) : 0,
    });

    try {
      const results = await mapWithConcurrency(
        batches.map((batch, index) => ({ batch, index })),
        this.options.concurrency,
        async ({ batch, index }) => {
          const batchAt = Date.now();
          const traceId = `${generationId}:${index + 1}`;
          logInfo("pipeline", "batch.begin", {
            generationId,
            traceId,
            batch: index + 1,
            posts: batch.length,
          });
          const result = await this.generator.generateBatch({
            game: context.game,
            posts: batch,
            contextPosts,
            traceId,
            toneExamples: context.toneExamples,
            replyTo: context.replyTo,
            avoidPhrases,
          });
          logInfo("pipeline", "batch.end", {
            generationId,
            traceId,
            batch: index + 1,
            posts: batch.length,
            durationMs: elapsedMs(batchAt),
          });
          return result;
        },
      );

      const selectionAt = Date.now();
      const suggestions = pickSuggestions(results, avoidPhrases);
      const strongest = [...results].sort((a, b) => b.confidence - a.confidence)[0];
      if (!strongest || suggestions.length !== 3) {
        this.generationError =
          "Suggestions overlapped recent chat or prior suggestions; waiting for fresher evidence.";
        this.queue.retry(posts);
        return this.deck;
      }

      const acknowledged = this.queue.acknowledge(posts);
      this.recentContext.add(acknowledged);
      for (const post of posts) this.usedPostIds.add(post.id);
      this.recentSuggestionTexts = [
        ...this.recentSuggestionTexts,
        ...suggestions.map((suggestion) => suggestion.text),
      ].slice(-24);
      const nextDeck: SuggestionDeck = {
        game: context.game,
        moment: strongest.moment,
        confidence:
          results.reduce((total, result) => total + result.confidence, 0) /
          results.length,
        suggestions,
        generatedAt: new Date().toISOString(),
        sourcePostCount: posts.length + contextPosts.length,
        bufferVersion: version,
        mode: this.generator.mode,
        thinkingMode: this.options.thinkingMode,
      };

      if (!this.deck || nextDeck.bufferVersion >= this.deck.bufferVersion) {
        this.deck = nextDeck;
      }
      logInfo("pipeline", "generation.end", {
        generationId,
        game: context.game,
        newPosts: posts.length,
        contextPosts: contextPosts.length,
        suggestions: suggestions.length,
        selectionDurationMs: elapsedMs(selectionAt),
        durationMs: elapsedMs(generationAt),
        pending: this.queue.pendingSize,
        recent: this.recentContext.size,
      });
      return this.deck;
    } catch (error) {
      this.queue.retry(posts);
      logError("pipeline", "generation.retry", error, {
        generationId,
        game: context.game,
        returnedToPending: posts.length,
        durationMs: elapsedMs(generationAt),
      });
      throw error;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.stopped) return;
    const elapsed = Date.now() - this.lastAttemptAt;
    const delay = Math.max(0, this.options.minIntervalMs - elapsed);
    logInfo("pipeline", "drain.scheduled", {
      game: this.getContext().game,
      pending: this.queue.pendingSize,
      delayMs: delay,
    });
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.request(true);
    }, delay);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function pickSuggestions(results: BatchResult[], avoidPhrases: string[] = []) {
  const styles: SuggestionStyle[] = ["safe", "funny", "spicy"];
  return styles.flatMap((style) => {
    const candidate = results
      .flatMap((result) =>
        result.suggestions
          .filter((suggestion) => suggestion.style === style)
          .map((suggestion) => ({ ...suggestion, confidence: result.confidence })),
      )
      .sort((a, b) => b.confidence - a.confidence)
      .find((suggestion) => !substantiallyOverlaps(suggestion.text, avoidPhrases));

    return candidate
      ? [{ id: `${style}-${crypto.randomUUID()}`, style, text: withoutTrailingPeriod(candidate.text) }]
      : [];
  });
}

function substantiallyOverlaps(candidate: string, avoidPhrases: string[]) {
  const candidateWords = meaningfulWords(candidate);
  if (candidateWords.length < 3) return false;
  const candidateText = candidateWords.join(" ");
  const candidatePhrases = wordPhrases(candidateWords);

  return avoidPhrases.some((phrase) => {
    const avoidedWords = meaningfulWords(phrase);
    if (avoidedWords.length < 3) return false;
    const avoidedText = avoidedWords.join(" ");
    if (candidateText.includes(avoidedText) || avoidedText.includes(candidateText)) {
      return true;
    }

    const sharedWords = candidateWords.filter((word) => avoidedWords.includes(word));
    if (sharedWords.length >= 3 && sharedWords.length / Math.min(candidateWords.length, avoidedWords.length) >= 0.65) {
      return true;
    }

    const avoidedPhrases = new Set(wordPhrases(avoidedWords));
    return candidatePhrases.some((value) => avoidedPhrases.has(value));
  });
}

function meaningfulWords(text: string) {
  const ignored = new Set([
    "a", "an", "and", "are", "at", "be", "but", "for", "from", "has", "have",
    "he", "her", "him", "i", "in", "is", "it", "its", "just", "like", "of", "on",
    "or", "our", "she", "that", "the", "their", "them", "they", "this", "to", "was",
    "we", "with", "you", "your",
  ]);
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length > 1 && !ignored.has(word),
  );
}

function wordPhrases(words: string[]) {
  return words.slice(0, -2).map((_, index) => words.slice(index, index + 3).join(" "));
}

function withoutTrailingPeriod(text: string) {
  return text.trim().replace(/\.+$/, "");
}

function selectDiversePosts(
  allPosts: SocialPost[],
  maximum: number,
  usedPostIds: Set<string>,
): SocialPost[] {
  const unseen = allPosts.filter((post) => !usedPostIds.has(post.id));
  // Once every buffered post has appeared in a generation, start a new cycle.
  if (unseen.length === 0) usedPostIds.clear();

  const fresh = unseen.length === 0 ? allPosts : unseen;
  const freshIds = new Set(fresh.map((post) => post.id));
  // Use every unseen item first, then fill any remaining slots from older
  // evidence so a partial new poll still has enough context to generate from.
  const candidates = fresh.length >= maximum
    ? fresh
    : [...fresh, ...allPosts.filter((post) => !freshIds.has(post.id))];
  return roundRobinSources(candidates, maximum);
}

function roundRobinSources(posts: SocialPost[], maximum: number): SocialPost[] {
  const queues = new Map<SocialPost["source"], SocialPost[]>();
  for (const post of posts) {
    const queue = queues.get(post.source) ?? [];
    queue.push(post);
    queues.set(post.source, queue);
  }

  const selected: SocialPost[] = [];
  while (selected.length < maximum) {
    let added = false;
    for (const queue of queues.values()) {
      const post = queue.shift();
      if (!post) continue;
      selected.push(post);
      added = true;
      if (selected.length === maximum) break;
    }
    if (!added) break;
  }
  return selected;
}

export const testing = { chunk, mapWithConcurrency, pickSuggestions, selectDiversePosts };
