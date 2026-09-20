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
  private usedPostIds = new Set<string>();
  private recentSuggestionTexts: string[] = [];

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
    const posts = selectDiversePosts(
      this.buffer.latest(Number.MAX_SAFE_INTEGER),
      this.options.maxPosts,
      this.usedPostIds,
    );
    const batches = chunk(posts, this.options.postsPerBatch);
    const context = this.getContext();
    // Chat history is a reply target. Only prior generated suggestions belong
    // on the avoid-list; otherwise the overlap guard rejects good replies that
    // deliberately engage with the conversation.
    const avoidPhrases = this.recentSuggestionTexts.slice(-24);

    const results = await mapWithConcurrency(
      batches,
      this.options.concurrency,
      (batch) =>
        this.generator.generateBatch({
          game: context.game,
          posts: batch,
          toneExamples: context.toneExamples,
          replyTo: context.replyTo,
          avoidPhrases,
        }),
    );

    if (results.length === 0) return this.deck;

    const suggestions = pickSuggestions(results, avoidPhrases);
    const strongest = [...results].sort((a, b) => b.confidence - a.confidence)[0];
    if (!strongest || suggestions.length !== 3) {
      this.generationError =
        "Suggestions overlapped prior wording; waiting for fresher evidence.";
      return this.deck;
    }

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
      for (const post of posts) this.usedPostIds.add(post.id);
      this.recentSuggestionTexts = [
        ...this.recentSuggestionTexts,
        ...suggestions.map((suggestion) => suggestion.text),
      ].slice(-24);
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

function pickSuggestions(
  results: BatchResult[],
  avoidPhrases: string[] = [],
) {
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
  return Array.from(
    { length: Math.max(0, words.length - 2) },
    (_, index) => words.slice(index, index + 3).join(" "),
  );
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
