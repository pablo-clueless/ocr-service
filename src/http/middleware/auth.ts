import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "crypto";

import { logger } from "../../observability/logger";
import { resolveTenant } from "../../auth/tenants";
import { env } from "../../config/env";
import { OcrError } from "../errors";

/**
 * API-key authentication (docs/regression-and-security.md V1). The caller sends
 * `Authorization: Bearer <key>` (or `X-API-Key: <key>`); the key is hashed and
 * looked up in the Postgres-backed tenant registry. Success sets `req.tenantId`
 * (and `req.tenant`), which scopes rate limiting and caching.
 *
 * **Fail-closed:** unlike the rate limiter, if the key store is unreachable we
 * reject (503) rather than admit. A short-TTL cache in the registry rides out
 * brief database blips so this isn't fragile.
 *
 * `AUTH_ENABLED=false` bypasses auth entirely (local dev only) — never in prod.
 */
export const auth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  req.requestId = req.requestId ?? `req_${randomBytes(8).toString("hex")}`;

  if (env.AUTH_ENABLED !== "true") {
    req.tenantId = "anonymous";
    next();
    return;
  }

  const key = extractApiKey(req);
  if (!key) {
    next(new OcrError("UNAUTHORIZED", "Missing API key (send 'Authorization: Bearer <key>' or 'X-API-Key')"));
    return;
  }

  try {
    const tenant = await resolveTenant(key);
    if (!tenant) {
      next(new OcrError("UNAUTHORIZED", "Invalid or revoked API key"));
      return;
    }
    req.tenantId = tenant.tenantId;
    req.tenant = tenant;
    next();
  } catch (err) {
    // Fail closed: the auth store is a hard dependency for a security control.
    logger.error("auth store unavailable", { err: err instanceof Error ? err.message : String(err) });
    next(new OcrError("PROVIDER_UNAVAILABLE", "Authentication store unavailable", { retryable: true }));
  }
};

/** Reads the key from `Authorization: Bearer <key>` or the `X-API-Key` header. */
const extractApiKey = (req: Request): string | undefined => {
  const authHeader = req.header("authorization");
  if (authHeader) {
    const [scheme, value] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value) return value.trim();
    // Tolerate a bare key in the Authorization header.
    if (!value && scheme) return scheme.trim();
  }
  const apiKeyHeader = req.header("x-api-key");
  return apiKeyHeader?.trim() || undefined;
};
