import { query } from "../db";
import { logger } from "./logger";

/**
 * Per-tenant usage counters for the admin console's "usage" panel.
 *
 * Deliberately kept out of Prometheus: a `tenant` label would make every metric
 * series cardinality-unbounded (one per API key). Instead these live in a single
 * `tenant_usage` row per tenantId — cheap to increment with an upsert, cheap to
 * read back whole:
 *
 *   tenant_usage(tenant_id, requests, errors, tokens)
 */

export type TenantUsage = {
  tenantId: string;
  requests: number;
  errors: number;
  tokens: number;
};

/**
 * Records one request against a tenant. **Fire-and-forget**: usage accounting must
 * never fail or slow a request, so this swallows database errors and is not awaited
 * by the pipeline. A pipeline-run for an unauthenticated dev request (tenantId
 * `anonymous`) is still counted under that id.
 */
export const recordTenantUsage = (
  tenantId: string,
  data: { outcome: "success" | "error"; tokensUsed?: number },
): void => {
  const errorsDelta = data.outcome === "error" ? 1 : 0;
  const tokensDelta = data.tokensUsed ?? 0;

  // Guard the synchronous path too: a missing/mocked db layer would otherwise throw
  // before we ever reach the promise `.catch`.
  try {
    query(
      `INSERT INTO tenant_usage (tenant_id, requests, errors, tokens)
       VALUES ($1, 1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET
         requests = tenant_usage.requests + 1,
         errors = tenant_usage.errors + $2,
         tokens = tenant_usage.tokens + $3`,
      [tenantId, errorsDelta, tokensDelta],
    ).catch((err) => {
      logger.warn("usage record failed", { tenantId, err: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    logger.warn("usage record failed", { tenantId, err: err instanceof Error ? err.message : String(err) });
  }
};

/** The `tenant_usage` row shape; bigint columns come back as strings from pg. */
type UsageRow = { tenant_id: string; requests: string; errors: string; tokens: string };

/** All tenants that have any recorded usage, most-requests first. */
export const getAllTenantUsage = async (): Promise<TenantUsage[]> => {
  const { rows } = await query<UsageRow>(`SELECT tenant_id, requests, errors, tokens FROM tenant_usage`);
  return rows
    .map((r) => ({
      tenantId: r.tenant_id,
      requests: Number(r.requests),
      errors: Number(r.errors),
      tokens: Number(r.tokens),
    }))
    .sort((a, b) => b.requests - a.requests);
};
