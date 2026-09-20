import { describe, expect, it } from "vitest";
import { EvidenceGenerator } from "../src/generators/evidenceGenerator.js";
import type { SocialPost } from "../src/types.js";

function post(text: string, index: number): SocialPost {
  return {
    id: `news:${index}`,
    source: "news",
    author: "Sports Desk",
    text,
    url: `https://example.com/${index}`,
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  };
}

describe("EvidenceGenerator", () => {
  it("uses real evidence text, matches lowercase tone, and limits copy length", async () => {
    const result = await new EvidenceGenerator().generateBatch({
      game: "test game",
      posts: [
        post("Arsenal edge Chelsea after a late winner - Sports Desk", 1),
        post("The midfield battle decided the match - Match Report", 2),
        post("A defensive error changed everything - Football Weekly", 3),
      ],
      toneExamples: ["bro is finished"],
      replyTo: "why are they still playing him?",
    });

    expect(result.moment).toContain("Arsenal edge Chelsea");
    expect(result.suggestions[1]?.text).toContain("bro");
    expect(result.suggestions[0]?.text).not.toMatch(/^on\b/i);
    expect(result.suggestions.every((item) => item.text === item.text.toLowerCase())).toBe(true);
    expect(result.suggestions.every((item) => item.text.split(/\s+/).length <= 12)).toBe(true);
  });

  it("keeps all three lines distinct when only one article is available", async () => {
    const result = await new EvidenceGenerator().generateBatch({
      game: "Warriors vs Cavaliers 2016 NBA Finals",
      posts: [post("NBA Finals preview reveals the deciding matchup", 1)],
      toneExamples: ["bro is finished"],
      replyTo: "",
    });

    expect(new Set(result.suggestions.map((item) => item.text)).size).toBe(3);
  });

  it("never mirrors the final Discord message", async () => {
    const lastMessage = "that defense is absolutely finished tonight";
    const result = await new EvidenceGenerator().generateBatch({
      game: "Brighton vs Arsenal Premier League",
      posts: [post("Brighton beat Arsenal 3-0 after a late winner", 1)],
      toneExamples: ["bro is finished"],
      replyTo: `earlier chat\n${lastMessage}`,
    });

    expect(result.suggestions.every((item) => !item.text.includes("defense is absolutely finished"))).toBe(true);
  });

  it("keeps local fallback output English when source posts are not English", async () => {
    const result = await new EvidenceGenerator().generateBatch({
      game: "test game",
      posts: [post("El equipo gana con un gol en el ultimo minuto", 1)],
      toneExamples: [],
      replyTo: "",
    });

    expect(result.moment).toBe("Fresh live updates are coming in.");
    expect(result.suggestions.every((item) => /^[\x00-\x7F]+$/.test(item.text))).toBe(true);
  });

  it("resolves a vague goalie reaction using a fact in the evidence", async () => {
    const result = await new EvidenceGenerator().generateBatch({
      game: "Cape Verde World Cup goalkeeper",
      posts: [post("40-year-old Cape Verde goalkeeper Vozinha stuns the World Cup", 1)],
      toneExamples: ["bro is finished"],
      replyTo: "Holy this goalie!",
    });

    expect(result.suggestions[0]?.text).toContain("vozinha");
    expect(result.suggestions.every((item) => item.text.includes("40"))).toBe(true);
  });
});
