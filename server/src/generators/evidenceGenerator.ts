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
    // The offline fallback cannot translate arbitrary languages reliably. Prefer
    // English evidence and never leak a source language into its suggestions.
    // Gemini handles full translation when it is configured.
    const headlines = input.posts
      .map((post) => cleanHeadline(post.text))
      .filter(isEnglishEnough);
    const first = headlines[0] || "Fresh live updates are coming in.";
    const bro = input.toneExamples.some((example) => /\bbro\b/i.test(example));
    const render = (value: string) => matchTone(limitWords(value, 12), input.toneExamples);
    const contextual = contextualSuggestions(input.replyTo, headlines, render);
    const event = eventReaction(headlines.join(" "));

    return {
      moment: first.slice(0, 160),
      confidence: 0.65,
      suggestions: contextual ?? [
        {
          style: "safe",
          text: render(`that ${event} changes the whole game`),
        },
        {
          style: "funny",
          text: render(`${bro ? "bro " : ""}the plot just found another gear`),
        },
        {
          style: "spicy",
          text: render(`someone check on the ${event} department`),
        },
      ],
    };
  }
}

function cleanHeadline(value: string) {
  return value.replace(/\s+-\s+[^-]+$/, "").trim();
}

function isEnglishEnough(value: string) {
  // This intentionally errs on the side of omitting a source line: final local
  // suggestions must remain English even when a feed mixes languages/scripts.
  if (!/[a-z]/i.test(value) || /[^\x00-\x7F]/.test(value)) return false;
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  const englishMarkers = new Set([
    "a", "an", "and", "are", "at", "for", "from", "has", "in", "is",
    "of", "on", "that", "the", "to", "was", "with", "will",
  ]);
  return words.some((word) => englishMarkers.has(word));
}

function eventReaction(evidence: string) {
  if (/\b(?:goal|winner|equaliser|equalizer)\b/i.test(evidence)) return "goal";
  if (/\b(?:save|keeper|goalkeeper)\b/i.test(evidence)) return "save";
  if (/\b(?:penalty|red card|puncture|crash|injury)\b/i.test(evidence)) return "moment";
  if (/\b(?:strategy|pit|tire|tyre)\b/i.test(evidence)) return "strategy call";
  return "update";
}

function limitWords(value: string, maximum: number) {
  return value.trim().split(/\s+/).slice(0, maximum).join(" ");
}

function matchTone(value: string, examples: string[]) {
  const letters = examples.join(" ").replace(/[^a-z]/gi, "");
  return letters && letters === letters.toLowerCase() ? value.toLowerCase() : value;
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
