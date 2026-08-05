import type { NextFunction, Request, Response } from "express";

import { SESSION_COOKIE, resolveSession } from "../../auth/admin-session";
import type { AdminRole } from "../../types/user";

/**
 * Admin-console authentication + role-based authorization. The console is a
 * same-origin surface served under `/admin`; the browser holds an httpOnly session
 * cookie (see src/auth/admin-session.ts) and every `/admin/api/*` route except
 * login runs through {@link adminAuth}, then a {@link requireMinRole} guard.
 *
 * These use a plain JSON error shape (`{ error: { code, message } }`) rather than
 * the OCR pipeline's {@link import("../errors").OcrError} — the admin surface has no
 * per-request `requestId` and its own status semantics.
 */

/** Least → most privileged. A caller satisfies a guard when their rank ≥ the minimum. */
const ROLE_RANK: Record<AdminRole, number> = { viewer: 0, manager: 1, owner: 2 };

const deny = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

/**
 * Minimal Cookie-header parser — Express 5 doesn't populate `req.cookies` without
 * cookie-parser, and the admin surface only needs one cookie, so parse inline
 * rather than add a dependency.
 */
export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
};

/**
 * Resolves the session cookie to `req.admin`, or rejects with 401. Fail-closed: any
 * missing/expired/revoked session is unauthorized.
 */
export const adminAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) {
    deny(res, 401, "UNAUTHORIZED", "Not signed in");
    return;
  }

  try {
    const session = await resolveSession(token);
    if (!session) {
      deny(res, 401, "UNAUTHORIZED", "Session expired or invalid");
      return;
    }
    req.admin = session;
    next();
  } catch {
    // Session store unreachable — fail closed (this is an access control).
    deny(res, 503, "PROVIDER_UNAVAILABLE", "Session store unavailable");
  }
};

/**
 * Guard factory: admits a caller whose role ranks at or above `min`. Assumes
 * {@link adminAuth} ran first (so `req.admin` is set); 403 otherwise.
 */
export const requireMinRole =
  (min: AdminRole) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const role = req.admin?.role;
    if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
      deny(res, 403, "FORBIDDEN", `Requires ${min} access`);
      return;
    }
    next();
  };
