import { createApp } from "./app.js";
import { config, maskSecret } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`iK(no)w Ball server listening on http://localhost:${config.port}`);
  console.log(`Using env file: ${config.envPath}`);
  console.log(`BROWSERBASE_API_KEY ${maskSecret(config.browserbaseApiKey)}`);
  console.log(`GEMINI_API_KEY ${maskSecret(config.geminiApiKey)}`);
  if (!config.browserbaseApiKey || !config.geminiApiKey) {
    console.warn("Real collection requires both Browserbase and Gemini API keys.");
  }
});
