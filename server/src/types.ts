import type { ThinkingMode } from "./thinkingMode.js";
import type { SearchMode } from "./searchMode.js";

export type { ThinkingMode };

export type Source = "x" | "reddit" | "news";

export interface SocialPost {
  id: string;
  source: Source;
  author: string;
  text: string;
  url: string;
  publishedAt: string;
  collectedAt: string;
  rank?: number;
}

export type SuggestionStyle = "safe" | "funny" | "spicy";

export interface Suggestion {
  id: string;
  style: SuggestionStyle;
  text: string;
}

export interface SuggestionDeck {
  game: string;
  moment: string;
  confidence: number;
  suggestions: Suggestion[];
  generatedAt: string;
  sourcePostCount: number;
  bufferVersion: number;
  mode: "gemini" | "local";
  thinkingMode: ThinkingMode;
}

export interface BatchResult {
  moment: string;
  confidence: number;
  suggestions: Array<{
    style: SuggestionStyle;
    text: string;
  }>;
}

export interface CollectorDetails {
  mode: "browserbase" | "google-news";
  searchMode: SearchMode;
  sessionId?: string;
  debugUrl?: string;
}

export interface Collector {
  start(query: string, sources: Source[]): Promise<CollectorDetails>;
  collect(): Promise<SocialPost[]>;
  stop(): Promise<void>;
}

export interface SuggestionGenerator {
  readonly mode: "gemini" | "local";
  readonly lastError?: string;
  generateBatch(input: {
    game: string;
    posts: SocialPost[];
    toneExamples: string[];
    replyTo: string;
  }): Promise<BatchResult>;
}
