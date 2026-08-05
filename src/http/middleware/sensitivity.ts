import type { NextFunction, Request, Response } from "express";

import { getFunction } from "../../functions/registry";

/**
 * Reads the resolved function's declared `sensitivity` and enforces the HTTP-layer
 * part of the policy (see docs/regression-and-security.md V2): for
 * `pii`/`restricted` it sets `Cache-Control: no-store` so responses carrying PII
 * are never cached by browsers or intermediaries.
 *
 * The rest of the policy is enforced deeper, where it can't be bypassed:
 *  - **no result caching** — the pipeline's extraction cache is skipped for any
 *    non-`standard` sensitivity;
 *  - **log redaction + no trace body capture** — the pipeline builds a redacting
 *    logger and calls `withSpan(..., { captureResult: false })`.
 */
export const sensitivity = (req: Request, res: Response, next: NextFunction): void => {
  const def = getFunction(String(req.params.function ?? ""));
  if (def) {
    req.sensitivity = def.sensitivity;
    if (def.sensitivity !== "standard") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    }
  }
  next();
};
