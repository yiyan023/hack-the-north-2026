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
      "2022 Argentina Cup Final France World",
    );
    expect(posts[0]).toMatchObject({
      source: "news",
      author: "Test News",
      text: "2022 World Cup Final Argentina vs France recap",
    });
  });
});
