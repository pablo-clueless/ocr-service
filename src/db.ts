import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { logger } from "./observability/logger";
import { env } from "./config/env";

/**
 * Shared Postgres pool for the durable stores — tenants, admins, and per-tenant
 * usage (see src/auth/tenants.ts, src/auth/admins.ts, src/observability/usage.ts).
 * Redis still backs the ephemeral/infrastructure concerns (BullMQ queue, rate
 * limiter, extraction cache, sessions); this is only the data that must survive a
 * restart and be backed up.
 *
 * A single lazily-created pool is reused process-wide. `connectionTimeoutMillis`
 * keeps a call from hanging when Postgres is unreachable — the auth path turns a
 * failure into a fail-closed rejection, while usage/cache callers degrade. The
 * `error` handler prevents an unhandled-error crash on an idle-client drop.
 */
let pool: Pool | undefined;

export const getPool = (): Pool => {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    pool.on("error", (err) => logger.warn("postgres pool error", { err: err.message }));
  }
  return pool;
};

/**
 * Convenience wrapper over the shared pool. `T` is the row shape; callers pass a
 * parameterized statement (`$1`, `$2`, …) — never interpolate values into SQL.
 */
export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> => getPool().query<T>(text, params as never);

/**
 * Idempotent schema bootstrap. Runs `CREATE TABLE IF NOT EXISTS` for the three
 * durable tables so a fresh deploy is usable without an out-of-band migration
 * step — the same "seed on boot" ethos as {@link ensureBootstrapAdmin}. Called
 * from both entrypoints (web + worker) and the provisioning CLIs. When the schema
 * outgrows this, swap it for a real migration runner; the call sites stay.
 */
export const ensureSchema = async (): Promise<void> => {
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      key_hash           text PRIMARY KEY,
      tenant_id          text NOT NULL,
      name               text,
      disabled           boolean NOT NULL DEFAULT false,
      rate_limit         integer,
      allowed_origins    jsonb,
      allowed_functions  jsonb,
      created_at         timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admins (
      id             uuid PRIMARY KEY,
      email          text NOT NULL UNIQUE,
      name           text NOT NULL,
      role           text NOT NULL,
      password_hash  text NOT NULL,
      disabled       boolean NOT NULL DEFAULT false,
      created_at     timestamptz NOT NULL,
      updated_at     timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_usage (
      tenant_id  text PRIMARY KEY,
      requests   bigint NOT NULL DEFAULT 0,
      errors     bigint NOT NULL DEFAULT 0,
      tokens     bigint NOT NULL DEFAULT 0
    );
  `);
};

/**
 * Resolves once the pool can serve a query (`SELECT 1`). Short-lived processes
 * (the provisioning CLIs, boot-time bootstrap) call this so their first real
 * statement doesn't race a cold pool against a remote/TLS Postgres. Rejects on
 * timeout so a CLI fails fast rather than hanging.
 */
export const whenDbReady = async (timeoutMs = 8000): Promise<void> => {
  let client: PoolClient | undefined;
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Postgres not ready after ${timeoutMs}ms`)), timeoutMs).unref(),
  );
  try {
    client = await Promise.race([getPool().connect(), timer]);
    await Promise.race([client.query("SELECT 1"), timer]);
  } finally {
    client?.release();
  }
};

/**
 * Closes the shared pool on graceful shutdown; a no-op if it was never created.
 * Safe to call more than once.
 */
export const closeDb = async (): Promise<void> => {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
};
