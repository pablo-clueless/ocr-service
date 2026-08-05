import { createHash, randomBytes } from "crypto";

import { logger } from "../observability/logger";
import { env } from "../config/env";
import { query } from "../db";

/**
 * Multi-tenant registry, backed by the `tenants` table (src/db.ts).
 *
 * Tenants are keyed by the **sha256 of the API key** — the raw key is never
 * stored, so a database dump can't be replayed as credentials. Provisioning
 * upserts a row; revoking deletes one. Tenants can be added/removed at runtime
 * without a redeploy.
 *
 * API keys are high-entropy random tokens, so sha256 (not bcrypt/argon2, which
 * exist for low-entropy passwords) is the correct, fast choice — and using the
 * hash as the primary key means we never string-compare a secret.
 */
export type Tenant = {
  tenantId: string;
  name?: string;
  /** When true, the key is rejected without being deleted (soft revoke). */
  disabled?: boolean;
  /** Per-tenant rate-limit override (requests per window); falls back to env. */
  rateLimit?: number;
  /**
   * Browser origins this tenant may call from. Unused while the service is
   * server-to-server only, but carried so a first-party dashboard can be added
   * later without a schema change.
   */
  allowedOrigins?: string[];
  /**
   * Function keys this tenant may call (e.g. `["RECEIPT_PARSING"]`). Omitted or
   * empty means **all** functions are allowed (backward-compatible). Enforced by
   * the authorize middleware — used to keep, say, `ID_VERIFICATION` off keys that
   * shouldn't touch PII.
   */
  allowedFunctions?: string[];
  createdAt?: string;
};

/** sha256 hex of an API key — the row's primary key and the cache key. */
export const hashApiKey = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex");

/** Generates a new random API key (43-char base64url, 256 bits of entropy). */
export const generateApiKey = (): string => randomBytes(32).toString("base64url");

/** The stored row shape (snake_case columns), mapped to/from the {@link Tenant} API. */
type TenantRow = {
  key_hash: string;
  tenant_id: string;
  name: string | null;
  disabled: boolean;
  rate_limit: number | null;
  allowed_origins: string[] | null;
  allowed_functions: string[] | null;
  created_at: Date;
};

const rowToTenant = (row: TenantRow): Tenant => ({
  tenantId: row.tenant_id,
  name: row.name ?? undefined,
  disabled: row.disabled,
  rateLimit: row.rate_limit ?? undefined,
  allowedOrigins: row.allowed_origins ?? undefined,
  allowedFunctions: row.allowed_functions ?? undefined,
  createdAt: row.created_at.toISOString(),
});

/** jsonb columns take a JSON string (or NULL); a bare JS array would bind as a Postgres array. */
const toJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

type CacheEntry = { tenant: Tenant; expiresAt: number };
const cache = new Map<string, CacheEntry>();

const cacheTtlMs = () => env.API_KEY_CACHE_TTL_SECONDS * 1000;

/**
 * Resolves an API key to its tenant, or `undefined` if unknown/disabled.
 *
 * Short-TTL positive caching keeps this off the database hot path and rides out
 * brief blips. **Throws** if the store is unreachable and nothing is cached — the
 * auth middleware turns that into a fail-closed rejection.
 */
export const resolveTenant = async (apiKey: string): Promise<Tenant | undefined> => {
  const keyHash = hashApiKey(apiKey);

  const hit = cache.get(keyHash);
  if (hit && hit.expiresAt > Date.now()) return hit.tenant.disabled ? undefined : hit.tenant;

  const tenant = await getTenantByHash(keyHash);
  if (!tenant) {
    cache.delete(keyHash);
    return undefined;
  }

  cache.set(keyHash, { tenant, expiresAt: Date.now() + cacheTtlMs() });
  return tenant.disabled ? undefined : tenant;
};

/**
 * Provenance for a registry mutation. `actor` identifies who made the change (a
 * CLI operator, or a future admin API's authenticated principal). Carried into
 * the audit log — the stdout log stream is the audit trail.
 */
export type AuditContext = { actor?: string };

/**
 * Upserts a tenant under an API key's hash. Used by provisioning. Emits a
 * `tenant.provisioned` audit line — the key-hash (never the raw key) is safe to
 * log and lets a mutation be correlated with the stored row.
 */
export const putTenant = async (apiKey: string, tenant: Tenant, audit: AuditContext = {}): Promise<void> => {
  const keyHash = hashApiKey(apiKey);
  await query(
    `INSERT INTO tenants
       (key_hash, tenant_id, name, disabled, rate_limit, allowed_origins, allowed_functions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, COALESCE($8::timestamptz, now()))
     ON CONFLICT (key_hash) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       name = excluded.name,
       disabled = excluded.disabled,
       rate_limit = excluded.rate_limit,
       allowed_origins = excluded.allowed_origins,
       allowed_functions = excluded.allowed_functions,
       created_at = excluded.created_at`,
    [
      keyHash,
      tenant.tenantId,
      tenant.name ?? null,
      tenant.disabled ?? false,
      tenant.rateLimit ?? null,
      toJsonb(tenant.allowedOrigins),
      toJsonb(tenant.allowedFunctions),
      tenant.createdAt ?? null,
    ],
  );
  cache.delete(keyHash);
  logger.info("tenant.provisioned", {
    tenantId: tenant.tenantId,
    keyHash,
    actor: audit.actor ?? "unknown",
    rateLimit: tenant.rateLimit,
    allowedFunctions: tenant.allowedFunctions,
  });
};

/** Removes a tenant by API key (hard revoke). Emits a `tenant.revoked` audit line. */
export const revokeApiKey = async (apiKey: string, audit: AuditContext = {}): Promise<number> => {
  const keyHash = hashApiKey(apiKey);
  cache.delete(keyHash);
  const { rowCount } = await query(`DELETE FROM tenants WHERE key_hash = $1`, [keyHash]);
  const removed = rowCount ?? 0;
  logger.info("tenant.revoked", { keyHash, actor: audit.actor ?? "unknown", removed });
  return removed;
};

/**
 * All tenants in the registry, each paired with the sha256 key-hash that indexes
 * it. Backs `provision:tenant list`; the raw API key is unrecoverable by design,
 * so the hash is the only stable per-tenant identifier surfaced here.
 */
export const listTenants = async (): Promise<Array<{ keyHash: string; tenant: Tenant }>> => {
  const { rows } = await query<TenantRow>(`SELECT * FROM tenants ORDER BY created_at ASC`);
  return rows.map((row) => ({ keyHash: row.key_hash, tenant: rowToTenant(row) }));
};

/**
 * The admin console identifies tenants by their key-hash (the raw key is
 * unrecoverable), so the mutators below key off the hash — the counterpart to the
 * raw-key {@link putTenant}/{@link revokeApiKey} used by CLI provisioning.
 *
 * Each clears the in-memory {@link cache} entry so this process sees the change at
 * once. That cache is per-process: the worker process (a separate cache) converges
 * within `API_KEY_CACHE_TTL_SECONDS` — acceptable for enable/disable/rate changes.
 */

/** Reads a single tenant by its key-hash, or `undefined` if unknown. */
export const getTenantByHash = async (keyHash: string): Promise<Tenant | undefined> => {
  const { rows } = await query<TenantRow>(`SELECT * FROM tenants WHERE key_hash = $1`, [keyHash]);
  return rows[0] ? rowToTenant(rows[0]) : undefined;
};

/** Fields an operator may change on an existing tenant. */
export type TenantPatch = Pick<Tenant, "name" | "rateLimit" | "allowedFunctions" | "allowedOrigins" | "disabled">;

/**
 * Merges a patch onto the tenant at `keyHash`. Only the provided fields change.
 * Returns the updated record, or `undefined` if no such tenant. Emits
 * `tenant.updated`.
 */
export const updateTenantByHash = async (
  keyHash: string,
  patch: TenantPatch,
  audit: AuditContext = {},
): Promise<Tenant | undefined> => {
  const { rows } = await query<TenantRow>(
    `UPDATE tenants SET
       name = COALESCE($2, name),
       rate_limit = COALESCE($3, rate_limit),
       allowed_functions = COALESCE($4::jsonb, allowed_functions),
       allowed_origins = COALESCE($5::jsonb, allowed_origins),
       disabled = COALESCE($6, disabled)
     WHERE key_hash = $1
     RETURNING *`,
    [
      keyHash,
      patch.name ?? null,
      patch.rateLimit ?? null,
      toJsonb(patch.allowedFunctions),
      toJsonb(patch.allowedOrigins),
      patch.disabled ?? null,
    ],
  );
  if (!rows[0]) return undefined;

  cache.delete(keyHash);
  const next = rowToTenant(rows[0]);
  logger.info("tenant.updated", {
    tenantId: next.tenantId,
    keyHash,
    actor: audit.actor ?? "unknown",
    disabled: next.disabled,
    rateLimit: next.rateLimit,
    allowedFunctions: next.allowedFunctions,
  });
  return next;
};

/** Removes a tenant by its key-hash (hard revoke). Emits `tenant.revoked`. */
export const revokeByHash = async (keyHash: string, audit: AuditContext = {}): Promise<number> => {
  cache.delete(keyHash);
  const { rowCount } = await query(`DELETE FROM tenants WHERE key_hash = $1`, [keyHash]);
  const removed = rowCount ?? 0;
  logger.info("tenant.revoked", { keyHash, actor: audit.actor ?? "unknown", removed });
  return removed;
};
