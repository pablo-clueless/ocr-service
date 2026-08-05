import { Queue, type JobState } from "bullmq";
import IORedis from "ioredis";

import { OcrErrorCode, type OcrErrorCode as OcrErrorCodeType } from "../http/errors";
import type { OcrRequest } from "../pipeline";
import { env } from "../config/env";

/**
 * Async job queue. Requests go async when `pageCount > threshold`
 * or `sizeBytes > threshold`. Same registry, same `execute`; the worker just
 * calls the pipeline off-request. Backed by BullMQ over Redis.
 */
export type OcrJobData = {
  function: string;
  request: OcrRequest;
};

export type JobStatus = "queued" | "active" | "completed" | "failed";

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  /** Tenant that submitted the job — used to scope lookups; never cross-tenant. */
  tenantId?: string;
  result?: unknown;
  error?: { code: string; message: string };
};

export interface OcrQueue {
  enqueue(data: OcrJobData): Promise<string>;
  getStatus(jobId: string): Promise<JobRecord | undefined>;
}

/** BullMQ queue name; the worker binds to the same name. */
export const OCR_QUEUE_NAME = "ocr";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connection (blocking
 * commands). This is a separate connection from the shared rate-limiter client,
 * which is intentionally configured to fail fast instead.
 */
export const createQueueConnection = (): IORedis => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

let connection: IORedis | undefined;
let queue: Queue<OcrJobData> | undefined;

const getQueue = (): Queue<OcrJobData> => {
  if (!queue) {
    connection ??= createQueueConnection();
    queue = new Queue<OcrJobData>(OCR_QUEUE_NAME, { connection });
  }
  return queue;
};

/**
 * A failed job in Redis keeps only a `failedReason` string, so the worker encodes
 * the {@link OcrError} code into it (`CODE: message`) and this decodes it back —
 * preserving the typed code across the queue boundary.
 */
export const encodeJobError = (code: OcrErrorCodeType, message: string): string => `${code}: ${message}`;

const decodeJobError = (failedReason: string | undefined): { code: string; message: string } => {
  const raw = failedReason ?? "job failed";
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(raw);
  if (match && (OcrErrorCode as Record<string, string>)[match[1]!]) {
    return { code: match[1]!, message: match[2]! };
  }
  return { code: OcrErrorCode.EXTRACTION_FAILED, message: raw };
};

const toStatus = (state: JobState | "unknown"): JobStatus => {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    default:
      // waiting / delayed / prioritized / waiting-children / unknown
      return "queued";
  }
};

/** Aggregate queue state + a recent-jobs sample, for the admin console. */
export type QueueStats = {
  counts: { waiting: number; active: number; completed: number; failed: number; delayed: number };
  recent: Array<{ jobId: string; status: JobStatus; function: string; tenantId?: string }>;
};

/**
 * Snapshot of the async OCR queue: BullMQ's own counters plus the most recent
 * active/failed jobs (the ones an operator actually wants to see). Read-only — it
 * never mutates the queue.
 */
export const getQueueStats = async (): Promise<QueueStats> => {
  const q = getQueue();
  const counts = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  const jobs = await q.getJobs(["active", "failed"], 0, 19);
  const recent = jobs
    .filter((j): j is NonNullable<typeof j> => !!j)
    .map((j) => ({
      jobId: j.id ?? "unknown",
      status: j.finishedOn && j.failedReason ? ("failed" as JobStatus) : ("active" as JobStatus),
      function: j.data.function,
      tenantId: j.data.request.tenantId,
    }));
  return {
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    },
    recent,
  };
};

export const ocrQueue: OcrQueue = {
  async enqueue(data) {
    const job = await getQueue().add(OCR_QUEUE_NAME, data, {
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    if (!job.id) throw new Error("BullMQ did not assign a job id");
    return job.id;
  },

  async getStatus(jobId) {
    const job = await getQueue().getJob(jobId);
    if (!job) return undefined;

    const status = toStatus(await job.getState());
    const record: JobRecord = { jobId, status, tenantId: job.data.request.tenantId };
    if (status === "completed") record.result = job.returnvalue;
    if (status === "failed") record.error = decodeJobError(job.failedReason);
    return record;
  },
};
