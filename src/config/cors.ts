import cors, { type CorsOptions } from "cors";

import { env } from "./env";

/**
 * CORS policy (docs/regression-and-security.md V7). The service is
 * **server-to-server**: backend callers send no `Origin` header and ignore CORS
 * entirely, so the safe default is **closed** — no cross-origin browser reads.
 *
 * `CORS_ALLOWED_ORIGINS` (comma-separated) opts specific origins back in for the
 * day a first-party dashboard needs browser access; empty means CORS stays off
 * (no `Access-Control-Allow-Origin` header emitted). We never fall back to `*`.
 */
export const allowedOrigins: string[] = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const options: CorsOptions = {
  origin: allowedOrigins.length === 0 ? false : allowedOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Authorization", "X-API-Key", "Content-Type"],
  credentials: false,
};

export const corsMiddleware = cors(options);
