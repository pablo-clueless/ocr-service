import "dotenv/config";

import { initTracing, shutdownTracing } from "./observability/otel";
import { closeDb, ensureSchema } from "./db";
import { logger } from "./observability/logger";
import { startWorker } from "./jobs/worker";

/**
 * Dedicated worker entrypoint. Runs the BullMQ loop in its own process so async
 * jobs are drained independently of the HTTP server. Deploy alongside the API
 * (`node build/worker.js`).
 */
initTracing();

// Idempotent — either process may win the race to create the schema on a fresh
// deploy. Processed jobs record usage and resolve tenants, both of which hit Postgres.
ensureSchema().catch((err) =>
  logger.error("worker schema init failed", { err: err instanceof Error ? err.message : String(err) }),
);

const worker = startWorker();
logger.info("ocr worker started");

const shutdown = async (signal: string): Promise<void> => {
  logger.info("ocr worker shutting down", { signal });
  await worker.close();
  await shutdownTracing();
  await closeDb();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
