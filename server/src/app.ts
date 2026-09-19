import cors from "cors";
import express from "express";
import { z } from "zod";
import { SessionService } from "./sessionService.js";

const startSchema = z.object({
  game: z.string().trim().min(2).max(120),
  sources: z.array(z.enum(["x", "reddit"])).min(1).max(2).default(["x"]),
  toneExamples: z.array(z.string().trim().min(1).max(280)).max(10).default([]),
  thinkingMode: z.enum(["fast", "medium", "deep"]).default("medium"),
});

export function createApp(session = new SessionService()) {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/session/start", async (request, response) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      response.json(await session.start(parsed.data));
    } catch (error) {
      response.status(502).json({
        error: error instanceof Error ? error.message : "Unable to start session",
      });
    }
  });

  app.get("/api/session/status", (_request, response) => {
    response.json(session.snapshot());
  });

  app.post("/api/session/stop", async (_request, response) => {
    response.json(await session.stop());
  });

  app.get("/api/suggestions", async (_request, response) => {
    const deck = await session.suggestions();
    if (!deck) {
      response.status(202).json({ status: "warming_up", suggestions: [] });
      return;
    }
    response.json({ status: "ready", ...deck });
  });

  app.post("/api/suggestions/refresh", async (_request, response) => {
    const deck = await session.refresh();
    if (!deck) {
      response.status(202).json({ status: "warming_up", suggestions: [] });
      return;
    }
    response.json({ status: "ready", ...deck });
  });

  return app;
}
