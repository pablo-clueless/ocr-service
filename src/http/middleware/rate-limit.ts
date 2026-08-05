import type { NextFunction, Request, Response } from "express";

import { logger } from "../../observability/logger";
import { env } from "../../config/env";
import { getRedis } from "../../redis";
import { OcrError } from "../errors";

/**
 * Per-tenant rate limiting (fixes the DoS surface noted in
 * docs/regression-and-security.md V4). Fixed-window counter in Redis, keyed on
 * `tenantId` (falling back to client IP until real auth lands). Exhaustion
 * returns a `RATE_LIMITED` (429) error with `retryable: true`.
 *
 * **Fail-open:** if Redis is unreachable the limiter must not become the outage
 * it exists to prevent — it logs a warning and allows the request.
 */
export const rateLimit = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  if (env.RATE_LIMIT_ENABLED !== "true") {
    next();
    return;
  }

  const id = req.tenantId || req.ip || "anon";
  const max = req.tenant?.rateLimit ?? env.RATE_LIMIT_MAX;
  try {
    const allowed = await underLimit(id, max);
    if (!allowed) {
      next(
        new OcrError("RATE_LIMITED", `Rate limit of ${max} requests per ${env.RATE_LIMIT_WINDOW_SECONDS}s exceeded`, {
          retryable: true,
        }),
      );
      return;
    }
    next();
  } catch (err) {
    logger.warn("rate limiter unavailable — failing open", { err: err instanceof Error ? err.message : String(err) });
    next();
  }
};

/** Fixed-window counter: INCR the window bucket, set its TTL on the first hit. */
const underLimit = async (id: string, max: number): Promise<boolean> => {
  const window = env.RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(Date.now() / 1000 / window);
  const key = `ratelimit:${id}:${bucket}`;

  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, window);
  }
  return count <= max;
};
