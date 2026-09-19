import type { SocialPost } from "./types.js";

export class RollingPostBuffer {
  private posts: SocialPost[] = [];
  private ids = new Set<string>();
  private _version = 0;

  constructor(private readonly capacity: number) {}

  get version(): number {
    return this._version;
  }

  get size(): number {
    return this.posts.length;
  }

  add(incoming: SocialPost[]): number {
    let added = 0;
    const unique = incoming
      .filter((post) => post.text.trim().length > 0)
      .filter((post) => {
        if (this.ids.has(post.id)) return false;
        this.ids.add(post.id);
        added += 1;
        return true;
      });

    if (unique.length === 0) return 0;

    this.posts = [...unique, ...this.posts]
      .sort(
        (a, b) =>
          Date.parse(b.publishedAt || b.collectedAt) -
          Date.parse(a.publishedAt || a.collectedAt),
      )
      .slice(0, this.capacity);

    this.ids = new Set(this.posts.map((post) => post.id));
    this._version += added;
    return added;
  }

  latest(limit: number): SocialPost[] {
    return this.posts.slice(0, Math.max(0, limit));
  }

  clear(): void {
    this.posts = [];
    this.ids.clear();
    this._version = 0;
  }
}
