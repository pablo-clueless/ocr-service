import { Router, type Request, type Response, type NextFunction } from "express";

import { buildCatalog, getFunction } from "../functions/registry";
import { authorizeFunction } from "./middleware/authorize";
import { runPipeline, type OcrRequest } from "../pipeline";
import { ocrQueue, type JobRecord } from "../jobs/queue";
import { sensitivity } from "./middleware/sensitivity";
import { FILE_FIELD, upload } from "../ingest/upload";
import { sendAccepted, sendSuccess } from "./respond";
import { rateLimit } from "./middleware/rate-limit";
import { getPipelineDeps } from "./deps";
import { auth } from "./middleware/auth";
import { OcrError } from "./errors";
import { env } from "../config/env";
import "./context";

/** Form field carrying the function arguments as a JSON string. */
export const ARGS_FIELD = "args";

/** Parses the multipart `args` field (a JSON string) into the raw args object. */
const parseArgsField = (raw: unknown): unknown => {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new OcrError("INVALID_ARGS", `The '${ARGS_FIELD}' field must be a valid JSON string`);
  }
};

/**
 * HTTP contract:
 *   GET  /v1/ocr/functions   → catalog + JSON Schemas
 *   POST /v1/ocr/:function    → multipart file + args (JSON string)
 *   GET  /v1/ocr/jobs/:id     → async job status + result
 */
export const ocrRouter = Router();

ocrRouter.get("/functions", (_req: Request, res: Response) => {
  res.json({ functions: buildCatalog() });
});

ocrRouter.post(
  "/:function",
  auth,
  authorizeFunction,
  rateLimit,
  sensitivity,
  upload.single(FILE_FIELD),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fnKey = String(req.params.function ?? "");
      const def = getFunction(fnKey);
      if (!def) {
        throw new OcrError("INVALID_ARGS", `Unknown function '${fnKey}'`);
      }
      if (!req.file) {
        throw new OcrError("INVALID_ARGS", `File is required in the '${FILE_FIELD}' field`);
      }

      const request: OcrRequest = {
        file: { buffer: req.file.buffer, originalName: req.file.originalname },
        args: parseArgsField(req.body?.[ARGS_FIELD]),
        requestId: req.requestId!,
        tenantId: req.tenantId!,
      };

      // Large jobs go async (202 + statusUrl); both paths call the identical
      // `runPipeline`. Gated to `standard` sensitivity — a `pii`/`restricted`
      // file must never be persisted into the Redis-backed queue.
      if (def.sensitivity === "standard" && (await shouldRunAsync(req.file.buffer))) {
        let jobId: string;
        try {
          jobId = await ocrQueue.enqueue({ function: def.key, request });
        } catch (err) {
          throw new OcrError("PROVIDER_UNAVAILABLE", "Could not enqueue the async job", {
            retryable: true,
            details: err instanceof Error ? err.message : String(err),
          });
        }
        sendAccepted(res, jobId);
        return;
      }

      const outcome = await runPipeline(def, request, getPipelineDeps());
      sendSuccess(res, 200, {
        requestId: request.requestId,
        function: def.key,
        result: outcome.result,
        meta: outcome.meta,
      });
    } catch (err) {
      next(err);
    }
  },
);

ocrRouter.get("/jobs/:id", auth, rateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = String(req.params.id ?? "");
    const record = await ocrQueue.getStatus(jobId);

    // Scope to the submitting tenant: a mismatch is reported as not-found so job
    // ids can't be enumerated across tenants. Only enforced when auth is active
    // (a tenant is present on both sides).
    const crossTenant = !!record?.tenantId && !!req.tenantId && record.tenantId !== req.tenantId;
    if (!record || crossTenant) {
      throw new OcrError("NOT_FOUND", `Job '${jobId}' not found`);
    }

    res.status(200).json({ requestId: req.requestId, ...stripInternal(record) });
  } catch (err) {
    next(err);
  }
});

/** Drops fields that are internal-only (tenant scoping) before returning to the client. */
const stripInternal = ({ tenantId: _tenantId, ...rest }: JobRecord): Omit<JobRecord, "tenantId"> => rest;

/**
 * Async decision, made pre-extraction from cheap signals: total bytes, and (for
 * PDFs) a page count read without a full OCR pass. Anything above the configured
 * thresholds is queued rather than processed on the request.
 */
const shouldRunAsync = async (buffer: Buffer): Promise<boolean> => {
  if (buffer.length > env.ASYNC_SIZE_THRESHOLD_BYTES) return true;
  const pages = await pdfPageCount(buffer);
  return pages > env.ASYNC_PAGE_THRESHOLD;
};

/** Page count for PDFs only (others have no meaningful pre-extraction count → 0). */
const pdfPageCount = async (buffer: Buffer): Promise<number> => {
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return 0;
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    return doc.getPageCount();
  } catch {
    // Encrypted/corrupt: let the sync path surface the real error rather than guess.
    return 0;
  }
};
