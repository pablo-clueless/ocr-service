import "dotenv/config";

import { generateApiKey, listTenants, putTenant, revokeApiKey, type Tenant } from "../auth/tenants";
import { closeDb, ensureSchema, whenDbReady } from "../db";

/**
 * Tenant provisioning CLI. Writes tenants into the Postgres-backed registry (see
 * src/auth/tenants.ts) — no admin service needed.
 *
 *   ts-node src/scripts/provision-tenant.ts create <tenantId> [--rate N] [--origins a,b]
 *   ts-node src/scripts/provision-tenant.ts list
 *   ts-node src/scripts/provision-tenant.ts revoke <apiKey>
 *
 * `create` prints the raw API key **once** — it is never stored (only its
 * sha256 is), so copy it now; it cannot be recovered. `create`/`revoke` emit an
 * audit line tagged with `--actor` (default: $USER) — the stdout log is the
 * audit trail, since there is no database.
 */
const usage = () => {
  console.error(
    [
      "Usage:",
      "  provision-tenant create <tenantId> [--rate <perWindow>] [--functions <A,B>] [--origins <a,b,c>] [--name <name>] [--actor <who>]",
      "  provision-tenant list",
      "  provision-tenant revoke <apiKey> [--actor <who>]",
    ].join("\n"),
  );
};

const getFlag = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Who is making the change, for the audit trail: `--actor`, else $USER, else "unknown". */
const resolveActor = (args: string[]): string => getFlag(args, "--actor") ?? process.env.USER ?? "unknown";

const main = async (): Promise<number> => {
  await whenDbReady();
  await ensureSchema();
  const [command, positional, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const tenants = await listTenants();
    if (tenants.length === 0) {
      console.log("No tenants provisioned.");
      return 0;
    }
    console.log(`\nTenants (${tenants.length}):\n`);
    for (const { keyHash, tenant } of tenants) {
      const fns = tenant.allowedFunctions?.length ? tenant.allowedFunctions.join(",") : "ALL";
      const rate = tenant.rateLimit ?? "default";
      const state = tenant.disabled ? " [disabled]" : "";
      console.log(`  ${tenant.tenantId}${state}`);
      console.log(`    key-hash:  ${keyHash.slice(0, 16)}…`);
      console.log(`    functions: ${fns}`);
      console.log(`    rate:      ${rate}`);
      console.log(`    created:   ${tenant.createdAt ?? "unknown"}\n`);
    }
    return 0;
  }

  if (command === "create") {
    if (!positional) {
      usage();
      return 1;
    }
    const rate = getFlag(rest, "--rate");
    const origins = getFlag(rest, "--origins");
    const functions = getFlag(rest, "--functions");
    const csv = (v: string | undefined): string[] | undefined =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const tenant: Tenant = {
      tenantId: positional,
      name: getFlag(rest, "--name"),
      rateLimit: rate ? Number(rate) : undefined,
      allowedOrigins: csv(origins),
      allowedFunctions: csv(functions),
      createdAt: new Date().toISOString(),
    };

    const apiKey = generateApiKey();
    await putTenant(apiKey, tenant, { actor: resolveActor(rest) });

    console.log(`\n✅ Provisioned tenant '${tenant.tenantId}'.`);
    console.log(`\n   API key (shown once — store it now):\n\n   ${apiKey}\n`);
    console.log("   Send it as:  Authorization: Bearer <key>\n");
    return 0;
  }

  if (command === "revoke") {
    if (!positional) {
      usage();
      return 1;
    }
    const removed = await revokeApiKey(positional, { actor: resolveActor(rest) });
    console.log(removed > 0 ? "✅ Key revoked." : "⚠️  Key not found (already revoked?).");
    return 0;
  }

  usage();
  return 1;
};

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("provision-tenant failed:", err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
