import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { SessionService } from "../src/sessionService.js";

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("session start thinking mode", () => {
  const started: unknown[] = [];
  let server: Awaited<ReturnType<typeof listen>> | undefined;

  afterEach(async () => {
    started.length = 0;
    await server?.close();
    server = undefined;
  });

  it("defaults to medium and forwards the dropdown selection", async () => {
    const session = {
      start: async (input: unknown) => {
        started.push(input);
        return { ok: true, thinkingMode: (input as { thinkingMode: string }).thinkingMode };
      },
    } as unknown as SessionService;

    server = await listen(createApp(session));

    const withoutMode = await fetch(`${server.url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: "Arsenal vs Chelsea", sources: ["x"] }),
    });
    expect(withoutMode.ok).toBe(true);
    expect(started[0]).toMatchObject({ thinkingMode: "medium" });

    const fast = await fetch(`${server.url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game: "Arsenal vs Chelsea",
        sources: ["x"],
        thinkingMode: "fast",
      }),
    });
    expect(fast.ok).toBe(true);
    expect(started[1]).toMatchObject({ thinkingMode: "fast" });

    const deep = await fetch(`${server.url}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game: "Arsenal vs Chelsea",
        sources: ["x"],
        thinkingMode: "deep",
      }),
    });
    expect(deep.ok).toBe(true);
    expect(started[2]).toMatchObject({ thinkingMode: "deep" });
  });
});
