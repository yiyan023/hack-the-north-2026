import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`iK(no)w Ball server listening on http://localhost:${config.port}`);
  if (!config.browserbaseApiKey || !config.geminiApiKey || config.forceDemoMode) {
    console.log("Running with demo components for any missing API keys.");
  }
});
