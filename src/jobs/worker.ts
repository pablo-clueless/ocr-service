import { Worker } from "bullmq";

import { OCR_QUEUE_NAME, createQueueConnection, encodeJobError, type OcrJobData } from "./queue";
import { runPipeline, type OcrRequest } from "../pipeline";
import { getFunction } from "../functions/registry";
import { logger } from "../observability/logger";
import { getPipelineDeps } from "../http/deps";
import { OcrError } from "../http/errors";

/** Off-request jobs are less latency-sensitive; a modest fixed concurrency. */
const WORKER_CONCURRENCY = 4;

/**
 * Queue worker. Pulls {@link OcrJobData}, resolves the function
 * from the registry, and runs the same `runPipeline` the sync path uses — the
 * only difference is it happens off-request.
 */
export const processJob = async (data: OcrJobData): Promise<unknown> => {
  const def = getFunction(data.function);
  if (!def) {
    throw new OcrError("INVALID_ARGS", `Unknown function '${data.function}'`);
  }
  const request = reviveRequest(data.request);
  return runPipeline(def, request, getPipelineDeps());
};

/**
 * Starts the BullMQ worker loop. Call from a dedicated worker entrypoint. Returns
 * the {@link Worker} so the entrypoint can close it on shutdown.
 */
export const startWorker = (): Worker<OcrJobData> => {
  const worker = new Worker<OcrJobData>(
    OCR_QUEUE_NAME,
    async (job) => {
      try {
        return await processJob(job.data);
      } catch (err) {
        // Encode the typed code so the job-status lookup can recover it — Redis
        // only persists the failure *message*, not the error object.
        if (err instanceof OcrError) throw new Error(encodeJobError(err.code, err.message));
        throw err;
      }
    },
    { connection: createQueueConnection(), concurrency: WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => logger.info("job completed", { jobId: job.id }));
  worker.on("failed", (job, err) => logger.error("job failed", { jobId: job?.id, err: err.message }));
  worker.on("error", (err) => logger.error("worker error", { err: err.message }));

  return worker;
};

/**
 * BullMQ serializes job data as JSON, so `file.buffer` arrives as a plain
 * `{ type: "Buffer", data: number[] }` rather than a {@link Buffer}. Reconstruct
 * it so the pipeline receives real bytes.
 */
const reviveRequest = (request: OcrRequest): OcrRequest => ({
  ...request,
  file: { ...request.file, buffer: toBuffer(request.file.buffer) },
});

const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data);
  }
  throw new OcrError("EXTRACTION_FAILED", "Job payload is missing valid file bytes");
};
