import type {
  Collector,
  CollectorDetails,
  SocialPost,
  Source,
} from "../types.js";

const samples = [
  "That press is getting bypassed every single time.",
  "The right back has been left on an island all match.",
  "Three shots from outside the box and none have troubled the keeper.",
  "Their midfield has completely disappeared since the restart.",
  "He has been offside more often than he has touched the ball.",
  "The manager waited ten minutes too long to make that substitution.",
  "That first touch turned a counterattack into a throw-in.",
  "They are defending this lead like there are thirty seconds left.",
  "Every dangerous attack is coming down the same side.",
  "The keeper is the only reason this is still level.",
  "This referee has decided that shoulder checks are legal today.",
  "The striker has won exactly zero duels against that centre-back.",
];

export class DemoCollector implements Collector {
  private cursor = 0;
  private query = "the game";
  private sources: Source[] = ["x"];

  async start(query: string, sources: Source[]): Promise<CollectorDetails> {
    this.query = query;
    this.sources = sources.length > 0 ? sources : ["x"];
    this.cursor = 0;
    return { mode: "demo" };
  }

  async collect(): Promise<SocialPost[]> {
    const now = new Date();
    const posts = Array.from({ length: 6 }, (_, offset) => {
      const sampleIndex = (this.cursor + offset) % samples.length;
      const source = this.sources[sampleIndex % this.sources.length] ?? "x";
      const id = `${source}:demo:${this.cursor + offset}`;
      return {
        id,
        source,
        author: `demo_fan_${sampleIndex + 1}`,
        text: `${samples[sampleIndex]} (${this.query})`,
        url: `https://example.com/${id}`,
        publishedAt: new Date(now.getTime() - offset * 1_000).toISOString(),
        collectedAt: now.toISOString(),
      } satisfies SocialPost;
    });
    this.cursor += posts.length;
    return posts;
  }

  async stop(): Promise<void> {}
}
