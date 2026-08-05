export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Admin console access tier (see docs/admin-console). Ordered least → most
 * privileged; `requireRole` compares against this ranking.
 *
 *   viewer  → read-only observability
 *   manager → viewer + tenant create/edit/revoke
 *   owner   → manager + admin-user management
 */
export type AdminRole = "owner" | "manager" | "viewer";
