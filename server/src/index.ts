import { createApp } from "./app.js";
import { config, maskSecret } from "./config.js";
import { logInfo, logWarn } from "./observability.js";

const app = createApp();

app.listen(config.port, () => {
  logInfo("server", "listening", {
    url: `http://localhost:${config.port}`,
    envFile: config.envPath,
    browserbaseKey: maskSecret(config.browserbaseApiKey),
    geminiKey: maskSecret(config.geminiApiKey),
  });
  if (!config.browserbaseApiKey || !config.geminiApiKey) {
    logWarn("server", "provider-credentials.missing", {
      browserbaseConfigured: Boolean(config.browserbaseApiKey),
      geminiConfigured: Boolean(config.geminiApiKey),
    });
  }
});
