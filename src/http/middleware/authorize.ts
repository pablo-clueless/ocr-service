import type { NextFunction, Request, Response } from "express";

import { OcrError } from "../errors";

/**
 * Per-function authorization (docs/regression-and-security.md). Runs after
 * `auth` has resolved `req.tenant`. If the tenant declares `allowedFunctions`,
 * the requested function must be in that list; otherwise (omitted/empty) all
 * functions are allowed — backward-compatible.
 *
 * Keeps sensitive functions (e.g. `ID_VERIFICATION`) off keys that shouldn't
 * touch PII, without a redeploy — scope lives in the tenant record.
 */
export const authorizeFunction = (req: Request, _res: Response, next: NextFunction): void => {
  const allowed = req.tenant?.allowedFunctions;
  if (!allowed || allowed.length === 0) {
    next();
    return;
  }

  const fnKey = String(req.params.function ?? "");
  if (!allowed.includes(fnKey)) {
    next(new OcrError("FORBIDDEN", `This API key is not authorized for '${fnKey}'`));
    return;
  }
  next();
};
