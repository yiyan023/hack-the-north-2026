import type {
  BatchResult,
  SocialPost,
  SuggestionGenerator,
} from "../types.js";
import { elapsedMs, logWarn } from "../observability.js";

export class ResilientGenerator implements SuggestionGenerator {
  private localActive = false;
  lastError?: string;

  constructor(
    private readonly primary: SuggestionGenerator,
    private readonly local: SuggestionGenerator,
  ) {}

  get mode() {
    return this.localActive ? this.local.mode : this.primary.mode;
  }

  async generateBatch(input: {
    game: string;
    posts: SocialPost[];
    contextPosts?: SocialPost[];
    traceId?: string;
    toneExamples: string[];
    replyTo: string;
    avoidPhrases?: string[];
  }): Promise<BatchResult> {
    if (this.localActive) return this.local.generateBatch(input);
    const startedAt = Date.now();
    try {
      return await this.primary.generateBatch(input);
    } catch (error) {
      this.localActive = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      logWarn("generator", "fallback.local", {
        traceId: input.traceId,
        primaryDurationMs: elapsedMs(startedAt),
        error: this.lastError,
      });
      return this.local.generateBatch(input);
    }
  }
}
