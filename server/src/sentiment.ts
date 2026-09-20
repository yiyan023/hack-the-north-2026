import type { SocialPost } from "./types.js";

const POSITIVE = new Set([
  "clutch", "dominant", "excellent", "great", "goal", "incredible", "love",
  "win", "winner", "winning", "brilliant", "hyped", "unreal", "comeback",
]);
const NEGATIVE = new Set([
  "bad", "bottle", "bottled", "collapse", "disaster", "finished", "poor",
  "terrible", "lose", "lost", "losing", "mistake", "awful", "washed", "fraud",
]);

export function aggregateSentiment(posts: SocialPost[]): number {
  let positive = 0;
  let negative = 0;
  for (const post of posts) {
    for (const token of post.text.toLowerCase().split(/[^a-z]+/)) {
      if (POSITIVE.has(token)) positive += 1;
      if (NEGATIVE.has(token)) negative += 1;
    }
  }
  const total = positive + negative;
  return total === 0 ? 0 : (positive - negative) / total;
}

export function isMajorSentimentChange(previous: number, current: number, threshold: number): boolean {
  return Math.abs(current - previous) >= threshold;
}