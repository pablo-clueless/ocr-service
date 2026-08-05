import express, { type Request, type Response } from "express";
import morgan from "morgan";
import path from "path";

import { errorHandler, notFound } from "./http/middleware/error";
import { metricsContentType, renderMetrics } from "./observability/metrics";
import { adminApiRouter } from "./http/admin/routes";
import { corsMiddleware } from "./config/cors";
import { ocrRouter } from "./http/routes";

/** Builds the Express app. Kept free of `listen` so it can be imported by tests. */
export function main() {
  const app = express();

  // Default-closed CORS (server-to-server). See config/cors.ts.
  app.use(corsMiddleware);
  app.use(morgan("dev"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (_req: Request, res: Response) => {
    res.json({ message: "Heirs OCR API" });
  });

  // Liveness / provider reachability.
  app.get("/healthz", (_req: Request, res: Response) => res.json({ status: "ok" }));
  app.get("/readyz", (_req: Request, res: Response) => res.json({ status: "ok" }));

  // Prometheus scrape endpoint (unauthenticated, like the health probes — labels
  // carry no tenant data; keep it on an internal network).
  app.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", metricsContentType);
    res.send(await renderMetrics());
  });

  app.use("/v1/ocr", ocrRouter);

  // Admin console: static assets + JSON API, both under /admin. Same-origin (no
  // CORS). Login is open; other /admin/api routes gate on session + role. The
  // console is inert until an admin exists in Postgres (`pnpm provision:admin`).
  app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));
  app.use("/admin", adminApiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
