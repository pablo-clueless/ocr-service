import { randomUUID } from "crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

import type { AdminRole, User } from "../types/user";
import { query, whenDbReady } from "../db";
import { logger } from "../observability/logger";
import { env } from "../config/env";

/**
 * Admin-user registry — the operator-side twin of the tenant registry
 * (src/auth/tenants.ts). Admins log into the console at `/admin`; each has a role
 * (see {@link AdminRole}) that scopes what the API lets them do.
 *
 * Rows live in the `admins` table (src/db.ts), keyed by user id, with a UNIQUE
 * constraint on the (lowercased) login email — the database enforces one account
 * per email. The password is stored only as an **argon2id hash**; the plaintext is
 * never persisted and there is no way to recover it.
 *
 * As with tenants, the stdout log stream is the audit trail (`admin.created` /
 * `admin.updated` / `admin.deleted`).
 */

/** The stored shape: the public {@link User}, plus the role and the secret hash. */
type AdminRecord = User & {
  role: AdminRole;
  passwordHash: string;
  /** When true the account can't log in, without being deleted (soft disable). */
  disabled?: boolean;
};

/** What the API is allowed to expose: the public user + role, never the hash. */
export type AdminView = User & { role: AdminRole; disabled?: boolean };

/** The `admins` row shape (snake_case columns); timestamptz columns come back as Date. */
type AdminRow = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  password_hash: string;
  disabled: boolean;
  created_at: Date;
  updated_at: Date;
};

const rowToRecord = (r: AdminRow): AdminRecord => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  passwordHash: r.password_hash,
  disabled: r.disabled,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Login email is case-insensitive; normalize before every read/write. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Strips the secret before a record leaves this module. */
const toView = (record: AdminRecord): AdminView => {
  const { passwordHash: _passwordHash, ...view } = record;
  return view;
};

/**
 * argon2id with sensible interactive-login parameters. The library ships prebuilt
 * binaries (no native build), so this works on the slim runtime image as-is.
 */
const hashPassword = (plain: string): Promise<string> => argonHash(plain);

export type CreateAdminInput = {
  email: string;
  name: string;
  role: AdminRole;
  password: string;
};

/**
 * Creates an admin user. Rejects a duplicate email (the login key must be unique).
 * Returns the safe view; emits an `admin.created` audit line.
 */
export const createAdmin = async (input: CreateAdminInput, actor = "unknown"): Promise<AdminView> => {
  const email = normalizeEmail(input.email);

  if (await getAdminByEmail(email)) throw new Error(`An admin with email '${email}' already exists`);

  const now = new Date();
  const record: AdminRecord = {
    id: randomUUID(),
    email,
    name: input.name,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };

  await query(
    `INSERT INTO admins (id, email, name, role, password_hash, disabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [record.id, email, record.name, record.role, record.passwordHash, false, now, now],
  );
  logger.info("admin.created", { adminId: record.id, email, role: record.role, actor });
  return toView(record);
};

/** Resolves a login email to its full record (secret included) or `undefined`. */
export const getAdminByEmail = async (email: string): Promise<AdminRecord | undefined> => {
  const { rows } = await query<AdminRow>(`SELECT * FROM admins WHERE email = $1`, [normalizeEmail(email)]);
  return rows[0] ? rowToRecord(rows[0]) : undefined;
};

/** Resolves an id to its full record (secret included) or `undefined`. */
export const getAdminById = async (id: string): Promise<AdminRecord | undefined> => {
  const { rows } = await query<AdminRow>(`SELECT * FROM admins WHERE id = $1`, [id]);
  return rows[0] ? rowToRecord(rows[0]) : undefined;
};

/** All admins as safe views, sorted oldest-first. */
export const listAdmins = async (): Promise<AdminView[]> => {
  const { rows } = await query<AdminRow>(`SELECT * FROM admins ORDER BY created_at ASC`);
  return rows.map((r) => toView(rowToRecord(r)));
};

/** Count of owner accounts — used to block removing the last one (self-lockout guard). */
export const countOwners = async (): Promise<number> => {
  const { rows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM admins WHERE role = 'owner' AND disabled = false`,
  );
  return rows[0]?.n ?? 0;
};

/**
 * Seeds the first owner from `ADMIN_BOOTSTRAP_EMAIL`/`ADMIN_BOOTSTRAP_PASSWORD` when
 * the registry is **empty**, so the console is usable on a fresh deploy without any
 * out-of-band command. Idempotent and safe to call on every boot: once any admin
 * exists it does nothing, so it never overwrites a changed password or re-creates a
 * deleted account. Called from the web entrypoint (src/index.ts).
 */
export const ensureBootstrapAdmin = async (): Promise<void> => {
  // Wait for the pool to be serving first — on a fresh boot against a remote/TLS
  // Postgres the seed would otherwise race a cold pool and never land (it only
  // retries on the next boot).
  await whenDbReady();
  const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM admins`);
  if ((rows[0]?.n ?? 0) > 0) return;

  await createAdmin(
    {
      email: env.ADMIN_BOOTSTRAP_EMAIL,
      name: env.ADMIN_BOOTSTRAP_EMAIL.split("@")[0]!,
      role: "owner",
      password: env.ADMIN_BOOTSTRAP_PASSWORD,
    },
    "bootstrap",
  );
  logger.warn("admin bootstrap: seeded first owner — change the password after first login", {
    email: env.ADMIN_BOOTSTRAP_EMAIL,
  });
};

export type UpdateAdminInput = {
  name?: string;
  role?: AdminRole;
  disabled?: boolean;
  /** When present, resets the password to this new value (re-hashed). */
  password?: string;
};

/**
 * Updates an admin. Only the provided fields change; `password` is re-hashed.
 * Returns the safe view or `undefined` if no such admin. Emits `admin.updated`.
 */
export const updateAdmin = async (
  id: string,
  patch: UpdateAdminInput,
  actor = "unknown",
): Promise<AdminView | undefined> => {
  const passwordHash = patch.password ? await hashPassword(patch.password) : null;
  const { rows } = await query<AdminRow>(
    `UPDATE admins SET
       name = COALESCE($2, name),
       role = COALESCE($3, role),
       disabled = COALESCE($4, disabled),
       password_hash = COALESCE($5, password_hash),
       updated_at = $6
     WHERE id = $1
     RETURNING *`,
    [id, patch.name ?? null, patch.role ?? null, patch.disabled ?? null, passwordHash, new Date()],
  );
  if (!rows[0]) return undefined;

  const next = rowToRecord(rows[0]);
  logger.info("admin.updated", {
    adminId: id,
    actor,
    role: next.role,
    disabled: next.disabled,
    passwordReset: !!patch.password,
  });
  return toView(next);
};

/** Deletes an admin. Emits `admin.deleted`. Idempotent. */
export const deleteAdmin = async (id: string, actor = "unknown"): Promise<boolean> => {
  const { rows } = await query<{ email: string }>(`DELETE FROM admins WHERE id = $1 RETURNING email`, [id]);
  if (!rows[0]) return false;
  logger.info("admin.deleted", { adminId: id, email: rows[0].email, actor });
  return true;
};

/**
 * Verifies a plaintext password against a stored record. A disabled account always
 * fails, even with the right password. Returns false (never throws) on a malformed
 * hash so login stays constant-shaped.
 */
export const verifyPassword = async (record: AdminRecord, plain: string): Promise<boolean> => {
  if (record.disabled) return false;
  try {
    return await argonVerify(record.passwordHash, plain);
  } catch {
    return false;
  }
};
