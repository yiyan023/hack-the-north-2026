import path from "node:path";
import { describe, expect, it } from "vitest";
import { config, maskSecret } from "../src/config.js";

describe("env file loading", () => {
  it("reads API keys from the project .env and only prints a mask", () => {
    expect(path.basename(config.envPath)).toBe(".env");
    expect(config.envPath.endsWith(`${path.sep}.env.example`)).toBe(false);

    console.log("Using env file:", config.envPath);
    console.log("BROWSERBASE_API_KEY", maskSecret(config.browserbaseApiKey));
    console.log("GEMINI_API_KEY", maskSecret(config.geminiApiKey));

    expect(maskSecret("")).toBe("(empty)");
    expect(maskSecret("abcdefghij")).toBe("set (****ghij, 10 chars)");
    expect(maskSecret(config.browserbaseApiKey)).not.toBe(config.browserbaseApiKey);
    expect(maskSecret(config.geminiApiKey)).not.toBe(config.geminiApiKey);
    expect(config.browserbaseApiKey.length).toBeGreaterThan(0);
    expect(config.geminiApiKey.length).toBeGreaterThan(0);
  });
});
