import type { RollingPostBuffer } from "./rollingBuffer.js";
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
}

export class SuggestionPipeline {
  private deck?: SuggestionDeck;
  private running?: Promise<SuggestionDeck | undefined>;
  private rerunRequested = false;
  private lastAttemptAt = 0;
  private lastGeneratedVersion = 0;
  private generationError?: string;

  constructor(
    private readonly buffer: RollingPostBuffer,
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

  request(force = false): Promise<SuggestionDeck | undefined> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }

    if (!this.shouldGenerate(force)) return Promise.resolve(this.deck);

    this.running = this.generate()
      .catch((error) => {
        this.generationError = error instanceof Error ? error.message : String(error);
        console.error("Suggestion generation failed", error);
        return this.deck;
      })
      .finally(() => {
        this.running = undefined;
        if (this.rerunRequested) {
          this.rerunRequested = false;
          void this.request(false);
        }
      });
    return this.running;
  }

  private shouldGenerate(force: boolean): boolean {
    if (this.buffer.size === 0) return false;
    const now = Date.now();
    if (!force && now - this.lastAttemptAt < this.options.minIntervalMs) {
      return false;
    }

    const newPosts = this.buffer.version - this.lastGeneratedVersion;
    return (
      force ||
      (!this.deck && newPosts >= this.options.minNewPosts) ||
      newPosts >= this.options.minNewPosts ||
      (newPosts > 0 && this.isStale(now))
    );
  }

  private async generate(): Promise<SuggestionDeck | undefined> {
    this.generationError = undefined;
    this.lastAttemptAt = Date.now();
    const version = this.buffer.version;
    const posts = this.buffer.latest(this.options.maxPosts);
    const batches = chunk(posts, this.options.postsPerBatch);
    const context = this.getContext();

    const results = await mapWithConcurrency(
      batches,
      this.options.concurrency,
      (batch) =>
        this.generator.generateBatch({
          game: context.game,
          posts: batch,
          toneExamples: context.toneExamples,
          replyTo: context.replyTo,
        }),
    );

    if (results.length === 0) return this.deck;

    const suggestions = pickSuggestions(results);
    const strongest = [...results].sort((a, b) => b.confidence - a.confidence)[0];
    if (!strongest || suggestions.length !== 3) return this.deck;

    const nextDeck: SuggestionDeck = {
      game: context.game,
      moment: strongest.moment,
      confidence:
        results.reduce((total, result) => total + result.confidence, 0) /
        results.length,
      suggestions,
      generatedAt: new Date().toISOString(),
      sourcePostCount: posts.length,
      bufferVersion: version,
      mode: this.generator.mode,
      thinkingMode: this.options.thinkingMode,
    };

    if (!this.deck || nextDeck.bufferVersion >= this.deck.bufferVersion) {
      this.deck = nextDeck;
      this.lastGeneratedVersion = version;
    }
    return this.deck;
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

function pickSuggestions(results: BatchResult[]) {
  const styles: SuggestionStyle[] = ["safe", "funny", "spicy"];
  return styles.flatMap((style) => {
    const candidate = results
      .flatMap((result) =>
        result.suggestions
          .filter((suggestion) => suggestion.style === style)
          .map((suggestion) => ({ ...suggestion, confidence: result.confidence })),
      )
      .sort((a, b) => b.confidence - a.confidence)[0];

    return candidate
      ? [{ id: `${style}-${crypto.randomUUID()}`, style, text: withoutTrailingPeriod(candidate.text) }]
      : [];
  });
}

function withoutTrailingPeriod(text: string) {
  return text.trim().replace(/\.+$/, "");
}

export const testing = { chunk, mapWithConcurrency, pickSuggestions };
