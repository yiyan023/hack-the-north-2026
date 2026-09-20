import cors from "cors";
import express from "express";
import path from "node:path";
import { z } from "zod";
import { SessionService } from "./sessionService.js";

const startSchema = z.object({
  game: z.string().trim().min(2).max(120),
  sources: z.array(z.enum(["x", "news", "test"])).min(1).max(3).default(["news"]),
  toneExamples: z.array(z.string().trim().min(1).max(280)).max(10).default([]),
  replyTo: z.string().trim().max(1_000).default(""),
  thinkingMode: z.enum(["fast", "medium", "deep"]).default("medium"),
});

const contextSchema = z.object({
  replyTo: z.string().trim().max(1_000),
});


export function createApp(session = new SessionService()) {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.resolve(process.cwd(), "web")));

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

  app.get("/api/posts", (request, response) => {
    const rawLimit = Array.isArray(request.query.limit)
      ? request.query.limit[0]
      : request.query.limit;
    const parsedLimit = Number.parseInt(String(rawLimit ?? "12"), 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 12;
    response.json({ posts: session.posts(limit) });
  });

  app.post("/api/session/stop", async (_request, response) => {
    response.json(await session.stop());
  });

  app.post("/api/session/context", async (request, response) => {
    const parsed = contextSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    response.json(await session.updateReplyContext(parsed.data.replyTo));
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
