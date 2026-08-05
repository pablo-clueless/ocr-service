import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

/**
 * Backing stores for the units under test, built in vi.hoisted so they exist
 * before the hoisted vi.mock factories run:
 *
 *  - `query` runs real SQL against an in-memory Postgres (pg-mem) — the durable
 *    stores (admins, tenants, usage) exercise their actual statements with no
 *    external database, so `pnpm test` stays self-contained.
 *  - `fakeRedis` keeps just enough string semantics for admin sessions, which
 *    still live in Redis.
 */
const { query, ensureSchema, resetDb, fakeRedis, strings } = vi.hoisted(() => {
  // require (not import) so this runs inside the hoisted factory.
  const { newDb } = require("pg-mem") as typeof import("pg-mem");

  const DDL = `
    CREATE TABLE IF NOT EXISTS tenants (
      key_hash text PRIMARY KEY,
      tenant_id text NOT NULL,
      name text,
      disabled boolean NOT NULL DEFAULT false,
      rate_limit integer,
      allowed_origins jsonb,
      allowed_functions jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admins (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      role text NOT NULL,
      password_hash text NOT NULL,
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_usage (
      tenant_id text PRIMARY KEY,
      requests bigint NOT NULL DEFAULT 0,
      errors bigint NOT NULL DEFAULT 0,
      tokens bigint NOT NULL DEFAULT 0
    );
  `;

  let mem = newDb();
  let pool = new (mem.adapters.createPg().Pool)();

  const query = vi.fn((text: string, params?: unknown[]) => pool.query(text, params));
  const ensureSchema = async () => {
    mem.public.none(DDL);
  };
  const resetDb = async () => {
    mem = newDb();
    pool = new (mem.adapters.createPg().Pool)();
    mem.public.none(DDL);
    query.mockReset();
    query.mockImplementation((text: string, params?: unknown[]) => pool.query(text, params));
  };

  const strings = new Map<string, string>();
  const fakeRedis = {
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (strings.delete(key) ? 1 : 0)),
    ping: vi.fn(async () => "PONG"),
  };

  return { query, ensureSchema, resetDb, fakeRedis, strings };
});

vi.mock("../src/db", () => ({ query, ensureSchema, whenDbReady: async () => {}, closeDb: async () => {} }));
vi.mock("../src/redis", () => ({ getRedis: () => fakeRedis, whenRedisReady: async () => {} }));

import {
  countOwners,
  createAdmin,
  deleteAdmin,
  ensureBootstrapAdmin,
  getAdminByEmail,
  listAdmins,
  updateAdmin,
  verifyPassword,
} from "../src/auth/admins";
import { getTenantByHash, hashApiKey, putTenant, revokeByHash, updateTenantByHash } from "../src/auth/tenants";
import { adminAuth, parseCookies, requireMinRole } from "../src/http/middleware/admin-auth";
import { createSession, destroySession, resolveSession } from "../src/auth/admin-session";
import { getAllTenantUsage, recordTenantUsage } from "../src/observability/usage";

const reset = async () => {
  await resetDb();
  strings.clear();
};

describe("admin registry", () => {
  beforeEach(reset);

  it("creates, looks up, and verifies a password (never stores plaintext)", async () => {
    const view = await createAdmin({ email: "A@x.com", name: "A", role: "owner", password: "secret123" });
    expect(view).not.toHaveProperty("passwordHash");
    expect(view.email).toBe("a@x.com"); // normalized

    const record = await getAdminByEmail("a@x.com");
    expect(record).toBeDefined();
    expect(record!.passwordHash).not.toContain("secret123");
    expect(await verifyPassword(record!, "secret123")).toBe(true);
    expect(await verifyPassword(record!, "wrong")).toBe(false);
  });

  it("rejects a duplicate email", async () => {
    await createAdmin({ email: "dup@x.com", name: "D", role: "viewer", password: "secret123" });
    await expect(
      createAdmin({ email: "dup@x.com", name: "D2", role: "viewer", password: "secret123" }),
    ).rejects.toThrow(/already exists/);
  });

  it("listAdmins omits the password hash", async () => {
    await createAdmin({ email: "l@x.com", name: "L", role: "manager", password: "secret123" });
    const admins = await listAdmins();
    expect(admins).toHaveLength(1);
    expect(admins[0]).not.toHaveProperty("passwordHash");
  });

  it("verifyPassword fails for a disabled account even with the right password", async () => {
    const view = await createAdmin({ email: "d@x.com", name: "D", role: "viewer", password: "secret123" });
    await updateAdmin(view.id, { disabled: true });
    const record = await getAdminByEmail("d@x.com");
    expect(await verifyPassword(record!, "secret123")).toBe(false);
  });

  it("updateAdmin can reset the password and change role; deleteAdmin removes it", async () => {
    const view = await createAdmin({ email: "u@x.com", name: "U", role: "viewer", password: "secret123" });
    await updateAdmin(view.id, { role: "owner", password: "newpass123" });
    const record = await getAdminByEmail("u@x.com");
    expect(record!.role).toBe("owner");
    expect(await verifyPassword(record!, "newpass123")).toBe(true);

    expect(await deleteAdmin(view.id)).toBe(true);
    expect(await getAdminByEmail("u@x.com")).toBeUndefined();
  });

  it("countOwners counts only active owners", async () => {
    await createAdmin({ email: "o1@x.com", name: "O1", role: "owner", password: "secret123" });
    const o2 = await createAdmin({ email: "o2@x.com", name: "O2", role: "owner", password: "secret123" });
    await createAdmin({ email: "m@x.com", name: "M", role: "manager", password: "secret123" });
    expect(await countOwners()).toBe(2);
    await updateAdmin(o2.id, { disabled: true });
    expect(await countOwners()).toBe(1);
  });

  it("ensureBootstrapAdmin seeds one owner when empty, and is a no-op otherwise", async () => {
    await ensureBootstrapAdmin();
    const seeded = await listAdmins();
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.role).toBe("owner");

    // Idempotent: a second call must not add or overwrite anything.
    await ensureBootstrapAdmin();
    expect(await listAdmins()).toHaveLength(1);
  });
});

describe("admin sessions", () => {
  beforeEach(reset);

  it("resolves a live session to the admin's current role", async () => {
    const admin = await createAdmin({ email: "s@x.com", name: "S", role: "manager", password: "secret123" });
    const { token } = await createSession(admin.id, "manager");
    const session = await resolveSession(token);
    expect(session).toEqual({ userId: admin.id, role: "manager" });
  });

  it("returns undefined for an unknown token and after destroy", async () => {
    expect(await resolveSession("nope")).toBeUndefined();
    const admin = await createAdmin({ email: "s2@x.com", name: "S", role: "viewer", password: "secret123" });
    const { token } = await createSession(admin.id, "viewer");
    await destroySession(token);
    expect(await resolveSession(token)).toBeUndefined();
  });

  it("returns undefined when the underlying admin is disabled", async () => {
    const admin = await createAdmin({ email: "s3@x.com", name: "S", role: "owner", password: "secret123" });
    const { token } = await createSession(admin.id, "owner");
    await updateAdmin(admin.id, { disabled: true });
    expect(await resolveSession(token)).toBeUndefined();
  });
});

describe("admin auth middleware", () => {
  beforeEach(reset);

  const makeRes = () => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res as unknown as Response & { statusCode: number; body: any };
  };

  it("parseCookies splits a header into name/value pairs", () => {
    expect(parseCookies("a=1; admin_session=xyz; b=2")).toMatchObject({ a: "1", admin_session: "xyz", b: "2" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("rejects a request with no session cookie", async () => {
    const res = makeRes();
    const next = vi.fn();
    await adminAuth({ headers: {} } as Request, res, next as unknown as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.admin for a valid session", async () => {
    const admin = await createAdmin({ email: "auth@x.com", name: "A", role: "manager", password: "secret123" });
    const { token } = await createSession(admin.id, "manager");
    const req = { headers: { cookie: `admin_session=${token}` } } as Request;
    const next = vi.fn();
    await adminAuth(req, makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(req.admin).toEqual({ userId: admin.id, role: "manager" });
  });

  it("requireMinRole 403s below the required tier and passes at/above it", () => {
    const guard = requireMinRole("manager");

    const low = makeRes();
    const nextLow = vi.fn();
    guard({ admin: { userId: "1", role: "viewer" } } as Request, low, nextLow as unknown as NextFunction);
    expect(low.statusCode).toBe(403);
    expect(nextLow).not.toHaveBeenCalled();

    const okNext = vi.fn();
    guard({ admin: { userId: "1", role: "owner" } } as Request, makeRes(), okNext as unknown as NextFunction);
    expect(okNext).toHaveBeenCalled();
  });
});

describe("tenant by-hash mutators", () => {
  beforeEach(reset);

  it("updateTenantByHash merges the patch and leaves other fields intact", async () => {
    const apiKey = "raw-key";
    await putTenant(apiKey, { tenantId: "acme", rateLimit: 10 });
    const keyHash = hashApiKey(apiKey);

    const updated = await updateTenantByHash(keyHash, { disabled: true });
    expect(updated).toBeDefined();
    expect(updated!.disabled).toBe(true);
    expect(updated!.tenantId).toBe("acme");
    expect(updated!.rateLimit).toBe(10);
  });

  it("updateTenantByHash returns undefined for an unknown hash", async () => {
    expect(await updateTenantByHash("deadbeef", { disabled: true })).toBeUndefined();
  });

  it("revokeByHash removes the tenant", async () => {
    const apiKey = "raw-key-2";
    await putTenant(apiKey, { tenantId: "beta" });
    const keyHash = hashApiKey(apiKey);
    expect(await revokeByHash(keyHash)).toBe(1);
    expect(await getTenantByHash(keyHash)).toBeUndefined();
  });
});

describe("per-tenant usage", () => {
  beforeEach(reset);

  it("counts requests, errors, and tokens per tenant", async () => {
    recordTenantUsage("t1", { outcome: "success", tokensUsed: 100 });
    recordTenantUsage("t1", { outcome: "error", tokensUsed: 50 });
    recordTenantUsage("t2", { outcome: "success" });
    // Fire-and-forget: let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));

    const usage = await getAllTenantUsage();
    const t1 = usage.find((u) => u.tenantId === "t1")!;
    expect(t1).toMatchObject({ requests: 2, errors: 1, tokens: 150 });
    const t2 = usage.find((u) => u.tenantId === "t2")!;
    expect(t2).toMatchObject({ requests: 1, errors: 0, tokens: 0 });
  });

  it("never throws when the database rejects", async () => {
    query.mockRejectedValueOnce(new Error("postgres down"));
    expect(() => recordTenantUsage("t3", { outcome: "success" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
