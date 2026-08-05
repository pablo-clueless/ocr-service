import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { SESSION_COOKIE, createSession, destroySession } from "../../auth/admin-session";
import { adminAuth, parseCookies, requireMinRole } from "../middleware/admin-auth";
import { getMetricsSummary } from "../../observability/metrics";
import { getAllTenantUsage } from "../../observability/usage";
import { listFunctions } from "../../functions/registry";
import { logger } from "../../observability/logger";
import { getQueueStats } from "../../jobs/queue";
import type { User } from "../../types/user";
import { env } from "../../config/env";
import { getRedis } from "../../redis";
import { query } from "../../db";
import {
  countOwners,
  createAdmin,
  deleteAdmin,
  getAdminByEmail,
  getAdminById,
  listAdmins,
  updateAdmin,
  verifyPassword,
} from "../../auth/admins";
import {
  generateApiKey,
  listTenants,
  putTenant,
  revokeByHash,
  updateTenantByHash,
  type Tenant,
} from "../../auth/tenants";

/**
 * Admin console JSON API, mounted under `/admin` (paths here start with `/api`).
 * `POST /api/login` is the only open route; everything else requires a session
 * (`adminAuth`) and a minimum role (`requireMinRole`). Read routes are `viewer+`,
 * tenant mutations `manager+`, admin-user management `owner`.
 */
export const adminApiRouter = Router();

const ROLE = z.enum(["owner", "manager", "viewer"]);

/** Trims a record down to the public {@link User} — never leak the password hash. */
const publicUser = (u: User): User => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

/** Wraps an async handler so a thrown error becomes a 500 JSON instead of a hang. */
const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch((err) => {
      logger.error("admin route failed", { path: req.path, err: err instanceof Error ? err.message : String(err) });
      // If a response already went out, hand the error to Express so it can close
      // the socket — don't send again (that throws "headers already sent").
      if (res.headersSent) {
        next(err);
        return;
      }
      sendError(res, 500, "INTERNAL", "Unexpected error");
    });
  };

/**
 * True when the browser reached us over HTTPS — directly (`req.secure`) or via a
 * TLS-terminating proxy that forwards the original scheme in `X-Forwarded-Proto`.
 * We read the header ourselves rather than enabling global `trust proxy`, which
 * would also change `req.ip` resolution (the rate limiter keys on it).
 */
const isHttpsRequest = (req: Request): boolean =>
  req.secure || (req.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase() === "https";

/**
 * httpOnly session cookie, scoped to the console. `secure` is set from the actual
 * request scheme, not `NODE_ENV`: a `Secure` cookie is dropped by the browser over
 * plain HTTP, so tying it to `NODE_ENV=production` silently breaks any non-local
 * deployment served over HTTP (login succeeds, but the cookie is never stored, so
 * every subsequent request 401s). Over HTTPS the flag is still set.
 */
const setSessionCookie = (req: Request, res: Response, token: string, ttlSeconds: number): void => {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: isHttpsRequest(req),
    path: "/admin",
    maxAge: ttlSeconds * 1000,
  });
};

// ── Auth ────────────────────────────────────────────────────────────────────

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

adminApiRouter.post(
  "/api/login",
  handler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", "email and password are required");
      return;
    }

    // The admin store (Redis) is a hard dependency for this security control. If it
    // is unreachable, fail closed with 503 rather than a generic 500 — mirrors the
    // OCR auth middleware (src/http/middleware/auth.ts). A wrong password is a 401
    // below; only a store outage lands here.
    let admin, session;
    try {
      admin = await getAdminByEmail(parsed.data.email);
      // Same response whether the email is unknown or the password is wrong.
      if (!admin || !(await verifyPassword(admin, parsed.data.password))) {
        sendError(res, 401, "UNAUTHORIZED", "Invalid email or password");
        return;
      }
      session = await createSession(admin.id, admin.role);
    } catch (err) {
      logger.error("admin login: store unavailable", { err: err instanceof Error ? err.message : String(err) });
      sendError(res, 503, "PROVIDER_UNAVAILABLE", "Authentication store unavailable");
      return;
    }

    setSessionCookie(req, res, session.token, session.ttl);
    logger.info("admin.login", { adminId: admin.id, email: admin.email });
    res.json({ user: publicUser(admin), role: admin.role });
  }),
);

adminApiRouter.post(
  "/api/logout",
  adminAuth,
  handler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/admin" });
    res.json({ ok: true });
  }),
);

adminApiRouter.get(
  "/api/me",
  adminAuth,
  handler(async (req, res) => {
    const admin = await getAdminById(req.admin!.userId);
    if (!admin) {
      sendError(res, 401, "UNAUTHORIZED", "Account no longer exists");
      return;
    }
    res.json({ user: publicUser(admin), role: admin.role });
  }),
);

// ── Admin users (owner only) ──────────────────────────────────────────────────

const createAdminSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: ROLE,
  password: z.string().min(8),
});

const updateAdminSchema = z.object({
  name: z.string().min(1).optional(),
  role: ROLE.optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

adminApiRouter.get(
  "/api/admins",
  adminAuth,
  requireMinRole("owner"),
  handler(async (_req, res) => {
    res.json({ admins: await listAdmins() });
  }),
);

adminApiRouter.post(
  "/api/admins",
  adminAuth,
  requireMinRole("owner"),
  handler(async (req, res) => {
    const parsed = createAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid admin");
      return;
    }
    try {
      const admin = await createAdmin(parsed.data, req.admin!.userId);
      res.status(201).json({ admin });
    } catch (err) {
      sendError(res, 409, "CONFLICT", err instanceof Error ? err.message : "Could not create admin");
    }
  }),
);

adminApiRouter.patch(
  "/api/admins/:id",
  adminAuth,
  requireMinRole("owner"),
  handler(async (req, res) => {
    const parsed = updateAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid update");
      return;
    }
    const id = String(req.params.id);
    const target = await getAdminById(id);
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "No such admin");
      return;
    }

    // Self-lockout guard: don't let the last active owner be demoted or disabled.
    const removesOwner =
      target.role === "owner" && ((parsed.data.role && parsed.data.role !== "owner") || parsed.data.disabled === true);
    if (removesOwner && (await countOwners()) <= 1) {
      sendError(res, 400, "LAST_OWNER", "Cannot demote or disable the last owner");
      return;
    }

    const admin = await updateAdmin(id, parsed.data, req.admin!.userId);
    res.json({ admin });
  }),
);

adminApiRouter.delete(
  "/api/admins/:id",
  adminAuth,
  requireMinRole("owner"),
  handler(async (req, res) => {
    const id = String(req.params.id);
    const target = await getAdminById(id);
    if (!target) {
      sendError(res, 404, "NOT_FOUND", "No such admin");
      return;
    }
    if (target.role === "owner" && (await countOwners()) <= 1) {
      sendError(res, 400, "LAST_OWNER", "Cannot delete the last owner");
      return;
    }
    await deleteAdmin(id, req.admin!.userId);
    res.json({ ok: true });
  }),
);

// ── Tenants ──────────────────────────────────────────────────────────────────

const csv = z.array(z.string().min(1));
const createTenantSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).optional(),
  rateLimit: z.number().int().positive().optional(),
  allowedFunctions: csv.optional(),
  allowedOrigins: csv.optional(),
});
const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  rateLimit: z.number().int().positive().optional(),
  allowedFunctions: csv.optional(),
  allowedOrigins: csv.optional(),
  disabled: z.boolean().optional(),
});

adminApiRouter.get(
  "/api/tenants",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    res.json({ tenants: await listTenants() });
  }),
);

adminApiRouter.post(
  "/api/tenants",
  adminAuth,
  requireMinRole("manager"),
  handler(async (req, res) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid tenant");
      return;
    }
    const tenant: Tenant = { ...parsed.data, createdAt: new Date().toISOString() };
    const apiKey = generateApiKey();
    await putTenant(apiKey, tenant, { actor: req.admin!.userId });
    // The raw key is shown exactly once — it is never stored, only its hash.
    res.status(201).json({ tenant, apiKey });
  }),
);

adminApiRouter.patch(
  "/api/tenants/:keyHash",
  adminAuth,
  requireMinRole("manager"),
  handler(async (req, res) => {
    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ARGS", parsed.error.issues[0]?.message ?? "Invalid update");
      return;
    }
    const updated = await updateTenantByHash(String(req.params.keyHash), parsed.data, { actor: req.admin!.userId });
    if (!updated) {
      sendError(res, 404, "NOT_FOUND", "No such tenant");
      return;
    }
    res.json({ tenant: updated });
  }),
);

adminApiRouter.delete(
  "/api/tenants/:keyHash",
  adminAuth,
  requireMinRole("manager"),
  handler(async (req, res) => {
    const removed = await revokeByHash(String(req.params.keyHash), { actor: req.admin!.userId });
    if (removed === 0) {
      sendError(res, 404, "NOT_FOUND", "No such tenant");
      return;
    }
    res.json({ ok: true });
  }),
);

// ── Observability (viewer+) ───────────────────────────────────────────────────

adminApiRouter.get(
  "/api/functions",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    res.json({ functions: listFunctions().map((d) => d.key) });
  }),
);

adminApiRouter.get(
  "/api/metrics/summary",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    res.json(await getMetricsSummary());
  }),
);

adminApiRouter.get(
  "/api/usage",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    res.json({ usage: await getAllTenantUsage() });
  }),
);

adminApiRouter.get(
  "/api/queue",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    res.json(await getQueueStats());
  }),
);

adminApiRouter.get(
  "/api/health",
  adminAuth,
  requireMinRole("viewer"),
  handler(async (_req, res) => {
    let redisOk = false;
    try {
      redisOk = (await getRedis().ping()) === "PONG";
    } catch {
      redisOk = false;
    }
    let postgresOk = false;
    try {
      await query("SELECT 1");
      postgresOk = true;
    } catch {
      postgresOk = false;
    }
    res.json({
      status: "ok",
      redis: redisOk,
      postgres: postgresOk,
      providers: {
        tesseract: true, // always available (bundled)
        glm: env.GLM_ENABLED === "true",
        azureOpenAI: env.AZURE_OPENAI_ENABLED === "true",
      },
      version: env.VERSION,
    });
  }),
);
