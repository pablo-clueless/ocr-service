import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { logger } from "../../observability/logger";
import { OcrError } from "../errors";

/**
 * Terminal error middleware. Renders every error to the one typed envelope
 * — never a raw provider error. Zod failures become INVALID_ARGS.
 */
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const requestId = req.requestId ?? "unknown";

  if (err instanceof OcrError) {
    res.status(err.status).json(err.toBody(requestId));
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_ARGS",
        message: "Request validation failed",
        requestId,
        retryable: false,
        details: err.issues,
      },
    });
    return;
  }

  logger.error("unhandled error", { requestId, err: err instanceof Error ? err.message : String(err) });
  res.status(500).json({
    error: { code: "EXTRACTION_FAILED", message: "Internal server error", requestId, retryable: true },
  });
};

/** 404 fallthrough. */
export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "Route not found", requestId: req.requestId ?? "unknown", retryable: false },
  });
};
