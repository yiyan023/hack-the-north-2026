import { describe, expect, it } from "vitest";
import { GoogleNewsCollector } from "../src/collectors/googleNewsCollector.js";

const feed = `<?xml version="1.0"?><rss><channel>
  <item><title>Argentina and France meet again</title><link>https://example.com/one</link><guid>one</guid><pubDate>Sun, 18 Dec 2022 12:00:00 GMT</pubDate><source>Example Sports</source></item>
  <item><title>2022 World Cup Final Argentina vs France recap</title><link>https://example.com/two</link><guid>two</guid><pubDate>Sun, 18 Dec 2022 13:00:00 GMT</pubDate><source>Test News</source></item>
</channel></rss>`;

describe("GoogleNewsCollector", () => {
  it("turns a real RSS shape into source evidence and ranks historical matches", async () => {
    let requestedUrl = "";
    const collector = new GoogleNewsCollector(async (input) => {
      requestedUrl = String(input);
      return new Response(feed, { status: 200 });
    });
    const details = await collector.start(
      "Argentina vs France 2022 World Cup Final",
      ["news"],
    );
    const posts = await collector.collect();

    expect(details).toEqual({ mode: "google-news", searchMode: "historical" });
    expect(new URL(requestedUrl).searchParams.get("q")).toBe(
      '2022 Argentina France "World Cup Final"',
    );
    expect(posts[0]).toMatchObject({
      source: "news",
      author: "Test News",
      text: "2022 World Cup Final Argentina vs France recap",
    });
  });

  it("keeps a current-year query live and rejects old-year or wrong-sport headlines", async () => {
    const currentFeed = `<?xml version="1.0"?><rss><channel>
      <item><title>Tai Tzu-ying shines at 2020 Badminton Championships</title><link>https://example.com/old</link><guid>old</guid><pubDate>Sun, 20 Sep 2020 12:00:00 GMT</pubDate></item>
      <item><title>Kazakhstan prepares for 2026 Chess Championships</title><link>https://example.com/wrong</link><guid>wrong</guid><pubDate>Sun, 20 Sep 2026 12:00:00 GMT</pubDate></item>
      <item><title>Draw published for 2026 World Badminton Championships</title><link>https://example.com/right</link><guid>right</guid><pubDate>Sun, 20 Sep 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`;
    let requestedUrl = "";
    const collector = new GoogleNewsCollector(async (input) => {
      requestedUrl = String(input);
      return new Response(currentFeed, { status: 200 });
    });

    const details = await collector.start("2026 badminton championships", ["news"]);
    const posts = await collector.collect();

    expect(details.searchMode).toBe("live");
    expect(new URL(requestedUrl).searchParams.get("q")).toBe(
      '2026 "badminton championships" when:30d',
    );
    expect(posts.map((item) => item.text)).toEqual([
      "Draw published for 2026 World Badminton Championships",
    ]);
  });
});
