import { randomBytes } from "crypto";

import type { AdminRole } from "../types/user";
import { getAdminById } from "./admins";
import { env } from "../config/env";
import { getRedis } from "../redis";

/**
 * Redis-backed admin sessions for the console. Login mints an opaque high-entropy
 * token stored under `admin_session:<token>` with a TTL, carried to the browser in
 * an httpOnly cookie. Because the token is a random handle (not a JWT), logout /
 * revocation is a single `DEL` — there's no signed state to invalidate.
 *
 * On resolve we re-check the admin still exists and isn't disabled, so revoking or
 * disabling an account takes effect on its next request, not only at TTL expiry.
 */
const SESSION_PREFIX = "admin_session:";

/** Cookie name carrying the session token. */
export const SESSION_COOKIE = "admin_session";

/** The resolved caller identity attached to a request by the auth middleware. */
export type AdminSession = { userId: string; role: AdminRole };

const sessionKey = (token: string): string => `${SESSION_PREFIX}${token}`;

/** Creates a session for a user, returning the token and its TTL (seconds). */
export const createSession = async (userId: string, role: AdminRole): Promise<{ token: string; ttl: number }> => {
  const token = randomBytes(32).toString("base64url");
  const ttl = env.ADMIN_SESSION_TTL_SECONDS;
  await getRedis().set(sessionKey(token), JSON.stringify({ userId, role }), "EX", ttl);
  return { token, ttl };
};

/**
 * Resolves a session token to the current caller, or `undefined` if the token is
 * unknown/expired, or the underlying admin was deleted or disabled (or its role
 * changed — the fresh role is returned).
 */
export const resolveSession = async (token: string): Promise<AdminSession | undefined> => {
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return undefined;

  const { userId } = JSON.parse(raw) as AdminSession;
  const admin = await getAdminById(userId);
  if (!admin || admin.disabled) return undefined;
  return { userId, role: admin.role };
};

/** Destroys a session (logout). Idempotent. */
export const destroySession = async (token: string): Promise<void> => {
  await getRedis().del(sessionKey(token));
};
