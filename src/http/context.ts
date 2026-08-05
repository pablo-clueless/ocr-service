import type { AdminSession } from "../auth/admin-session";
import type { Sensitivity } from "../functions/define";
import type { Tenant } from "../auth/tenants";

/** Per-request fields attached by middleware and read by handlers. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      tenantId?: string;
      /** Resolved tenant record; set by the auth middleware. */
      tenant?: Tenant;
      /** Sensitivity of the resolved function; set by the sensitivity middleware. */
      sensitivity?: Sensitivity;
      /** Resolved admin-console caller; set by the adminAuth middleware. */
      admin?: AdminSession;
    }
  }
}

export {};
