import type {
  BatchResult,
  SocialPost,
  SuggestionGenerator,
} from "../types.js";

export class EvidenceGenerator implements SuggestionGenerator {
  readonly mode = "local" as const;

  async generateBatch(input: {
    game: string;
    posts: SocialPost[];
    toneExamples: string[];
    replyTo: string;
  }): Promise<BatchResult> {
    const headlines = input.posts.map((post) => cleanHeadline(post.text));
    const first = headlines[0] || input.game;
    const second = headlines[1] || first;
    const third = headlines[2] || second;
    const bro = input.toneExamples.some((example) => /\bbro\b/i.test(example));
    const render = (value: string) => matchTone(limitWords(value, 12), input.toneExamples);
    const reply = replyFragment(input.replyTo);
    const contextual = contextualSuggestions(input.replyTo, headlines, render);

    return {
      moment: first.slice(0, 160),
      confidence: 0.65,
      suggestions: contextual ?? [
        {
          style: "safe",
          text: render(limitWords(first, 10)),
        },
        {
          style: "funny",
          text: render(
            reply
              ? `${bro ? "bro " : ""}"${reply}" aged badly: ${limitWords(second, 4)}`
              : `${bro ? "bro " : ""}${limitWords(second, bro ? 8 : 9)} is wild`,
          ),
        },
        {
          style: "spicy",
          text: render(
            reply
              ? `"${reply}" is nasty work after ${limitWords(third, 5)}`
              : `${limitWords(third, 9)} is nasty work`,
          ),
        },
      ],
    };
  }
}

function cleanHeadline(value: string) {
  return value.replace(/\s+-\s+[^-]+$/, "").trim();
}

function limitWords(value: string, maximum: number) {
  return value.trim().split(/\s+/).slice(0, maximum).join(" ");
}

function matchTone(value: string, examples: string[]) {
  const letters = examples.join(" ").replace(/[^a-z]/gi, "");
  return letters && letters === letters.toLowerCase() ? value.toLowerCase() : value;
}

function replyFragment(value: string) {
  const latest = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || value;
  return latest.replace(/["“”]/g, "").split(/\s+/).slice(0, 8).join(" ");
}

function contextualSuggestions(
  replyTo: string,
  headlines: string[],
  render: (value: string) => string,
): BatchResult["suggestions"] | undefined {
  const evidence = headlines.join(" ");
  const refersToKeeper = /\b(?:goalie|keeper|goalkeeper)\b/i.test(replyTo);
  const saysForty = /\b40(?:-year-old| year old| years old)?\b/i.test(evidence);
  if (!refersToKeeper || !saysForty) return undefined;

  const keeper = /\bvozinha\b/i.test(evidence) ? "Vozinha" : "this keeper";
  return [
    { style: "safe", text: render(`yeah ${keeper} does not look 40 out there`) },
    { style: "funny", text: render("40 years old and moving like that is ridiculous") },
    { style: "spicy", text: render(`bro ${keeper} is making 40 look like his prime`) },
  ];
}
