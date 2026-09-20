import type { SocialPost } from "./types.js";

export class PendingPostQueue {
  private pending: SocialPost[] = [];
  private readonly inFlight = new Map<string, SocialPost>();
  private readonly seenIds = new Set<string>();
  private readonly seenText = new Set<string>();
  private _version = 0;

  constructor(private readonly capacity: number) {}

  get version(): number {
    return this._version;
  }

  get pendingSize(): number {
    return this.pending.length;
  }

  get inFlightSize(): number {
    return this.inFlight.size;
  }

  add(incoming: SocialPost[]): number {
    const unique: SocialPost[] = [];

    for (const post of incoming) {
      const fingerprint = textFingerprint(post.text);
      if (!fingerprint || this.seenIds.has(post.id) || this.seenText.has(fingerprint)) {
        continue;
      }

      this.seenIds.add(post.id);
      this.seenText.add(fingerprint);
      unique.push(post);
    }

    if (unique.length === 0) return 0;

    this.pending = sortPosts([...this.pending, ...unique]).slice(0, this.capacity);
    this._version += unique.length;
    return unique.length;
  }

  claim(limit: number): SocialPost[] {
    const claimed = this.pending.splice(0, Math.max(0, limit));
    for (const post of claimed) this.inFlight.set(post.id, post);
    return claimed;
  }

  acknowledge(posts: SocialPost[]): SocialPost[] {
    const acknowledged: SocialPost[] = [];
    for (const post of posts) {
      const current = this.inFlight.get(post.id);
      if (!current) continue;
      this.inFlight.delete(post.id);
      acknowledged.push(current);
    }
    return acknowledged;
  }

  retry(posts: SocialPost[]): void {
    const retryable: SocialPost[] = [];
    for (const post of posts) {
      const current = this.inFlight.get(post.id);
      if (!current) continue;
      this.inFlight.delete(post.id);
      retryable.push(current);
    }
    this.pending = sortPosts([...retryable, ...this.pending]).slice(0, this.capacity);
  }

  pendingPosts(limit: number): SocialPost[] {
    return this.pending.slice(0, Math.max(0, limit));
  }

  inFlightPosts(): SocialPost[] {
    return [...this.inFlight.values()];
  }

  clear(): void {
    this.pending = [];
    this.inFlight.clear();
    this.seenIds.clear();
    this.seenText.clear();
    this._version = 0;
  }
}

function sortPosts(posts: SocialPost[]): SocialPost[] {
  return posts.sort((a, b) => {
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
  });
}

function textFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const testing = { sortPosts, textFingerprint };
