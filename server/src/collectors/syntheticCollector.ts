import type {
  Collector,
  CollectorDetails,
  SocialPost,
  Source,
} from "../types.js";

const POST_INTERVALS_MS = [8_000, 18_000, 30_000, 44_000, 60_000];

export class SyntheticCollector implements Collector {
  private query = "";
  private startedAt = 0;
  private nextPost = 0;
  private preloaded = false;

  async start(query: string, _sources: Source[]): Promise<CollectorDetails> {
    this.query = query;
    this.startedAt = Date.now();
    this.nextPost = 0;
    this.preloaded = false;
    return { mode: "synthetic", searchMode: "live" };
  }

  async collect(): Promise<SocialPost[]> {
    const now = Date.now();
    const elapsed = now - this.startedAt;
    const posts: SocialPost[] = [];

    while (
      this.nextPost < POST_INTERVALS_MS.length &&
      elapsed >= POST_INTERVALS_MS[this.nextPost]!
    ) {
      posts.push(this.post(this.nextPost + 5, now));
      this.nextPost += 1;
    }

    if (!this.preloaded) {
      for (let index = 0; index < 5; index += 1) {
        posts.push(this.post(index, now));
      }
      this.preloaded = true;
    }

    return posts;
  }

  async stop(): Promise<void> {}

  private post(index: number, collectedAt: number): SocialPost {
    const timestamp = new Date(collectedAt - index * 30_000).toISOString();
    const moments = [
      `${this.query}: kickoff and both sides are pressing high`,
      `${this.query}: a dangerous counter nearly changes the match`,
      `${this.query}: midfield is becoming a real battle`,
      `${this.query}: the goalkeeper makes a sharp early save`,
      `${this.query}: the first half ends level`,
      `GOAL! ${this.query}: the home side score in the 78th minute`,
      `${this.query}: the defending team are hanging on in stoppage time`,
      `FULL TIME: ${this.query} ends with a dramatic late result`,
    ];
    return {
      id: `test:${index}`,
      source: "test",
      author: "Synthetic Match Desk",
      text: moments[index] ?? `${this.query}: fresh match reaction`,
      url: "https://example.com/synthetic-match",
      publishedAt: timestamp,
      collectedAt: new Date(collectedAt).toISOString(),
      rank: index,
    };
  }
}
