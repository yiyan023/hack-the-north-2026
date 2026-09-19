export const THINKING_MODES = ["fast", "medium", "deep"] as const;

export type ThinkingMode = (typeof THINKING_MODES)[number];

export const THINKING_MODE_POSTS = {
  fast: 2,
  medium: 10,
  deep: 30,
} as const satisfies Record<ThinkingMode, number>;

export function postsForThinkingMode(mode: ThinkingMode): number {
  return THINKING_MODE_POSTS[mode];
}

export function pipelineLimitsForThinkingMode(
  mode: ThinkingMode,
  defaults: { postsPerBatch: number; minNewPosts: number },
) {
  const maxPosts = postsForThinkingMode(mode);
  return {
    thinkingMode: mode,
    maxPosts,
    postsPerBatch: Math.min(defaults.postsPerBatch, maxPosts),
    minNewPosts: Math.min(defaults.minNewPosts, maxPosts),
  };
}
