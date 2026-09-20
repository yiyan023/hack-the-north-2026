import { createApp } from "./app.js";
import { config, maskSecret } from "./config.js";
import { logInfo, logWarn } from "./observability.js";
import { SessionService } from "./sessionService.js";

const session = new SessionService();
const app = createApp(session);

const server = app.listen(config.port, () => {
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
  if (config.browserbaseApiKey) {
    void session.prewarmBrowserbase().then((result) => {
      if (result.ready) {
        logInfo("server", "browserbase.prewarm.ready", {
          sessionId: result.sessionId,
        });
      }
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("server", "shutdown.begin", { signal });
  server.close();
  await session.shutdown();
  logInfo("server", "shutdown.end", { signal });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
