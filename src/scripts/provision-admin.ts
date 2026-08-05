import "dotenv/config";

import { createAdmin, deleteAdmin, getAdminByEmail, listAdmins } from "../auth/admins";
import { closeDb, ensureSchema, whenDbReady } from "../db";
import type { AdminRole } from "../types/user";

/**
 * Admin-user provisioning CLI — the operator twin of provision-tenant.ts. Seeds
 * the first console owner (there's a chicken-and-egg:
 * login needs an admin, so owner #0 is created out-of-band here), after which
 * owners manage the rest from the UI.
 *
 *   ts-node src/scripts/provision-admin.ts create [--email E] [--password P] [--role R] [--name N]
 *   ts-node src/scripts/provision-admin.ts list
 *   ts-node src/scripts/provision-admin.ts delete <email>
 *
 * `create` with no flags seeds the default first owner. The password is stored only
 * as an argon2 hash — change it after first login.
 */
const DEFAULT_EMAIL = "samson.okunola@heirstechnologies.com";
const DEFAULT_PASSWORD = "Admin@1234#";

const usage = (): void => {
  console.error(
    [
      "Usage:",
      "  provision-admin create [--email <e>] [--password <p>] [--role owner|manager|viewer] [--name <n>]",
      "  provision-admin list",
      "  provision-admin delete <email>",
    ].join("\n"),
  );
};

const getFlag = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const isRole = (v: string): v is AdminRole => v === "owner" || v === "manager" || v === "viewer";

const main = async (): Promise<number> => {
  await whenDbReady();
  await ensureSchema();
  const [command, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const admins = await listAdmins();
    if (admins.length === 0) {
      console.log("No admins provisioned.");
      return 0;
    }
    console.log(`\nAdmins (${admins.length}):\n`);
    for (const a of admins) {
      const state = a.disabled ? " [disabled]" : "";
      console.log(`  ${a.email}${state}`);
      console.log(`    id:      ${a.id}`);
      console.log(`    name:    ${a.name}`);
      console.log(`    role:    ${a.role}`);
      console.log(`    created: ${a.createdAt.toISOString()}\n`);
    }
    return 0;
  }

  if (command === "create") {
    const email = getFlag(rest, "--email") ?? DEFAULT_EMAIL;
    const password = getFlag(rest, "--password") ?? DEFAULT_PASSWORD;
    const roleRaw = getFlag(rest, "--role") ?? "owner";
    const name = getFlag(rest, "--name") ?? email.split("@")[0]!;

    if (!isRole(roleRaw)) {
      console.error(`Invalid role '${roleRaw}' (expected owner|manager|viewer).`);
      return 1;
    }
    if (await getAdminByEmail(email)) {
      console.error(`⚠️  An admin with email '${email}' already exists.`);
      return 1;
    }

    const admin = await createAdmin({ email, name, role: roleRaw, password }, "provision-admin");
    console.log(`\n✅ Provisioned admin '${admin.email}' (${admin.role}).`);
    if (password === DEFAULT_PASSWORD) {
      console.log("\n   Using the default password — change it after first login.\n");
    }
    return 0;
  }

  if (command === "delete") {
    const email = rest[0];
    if (!email) {
      usage();
      return 1;
    }
    const admin = await getAdminByEmail(email);
    if (!admin) {
      console.log("⚠️  No admin with that email.");
      return 0;
    }
    await deleteAdmin(admin.id, "provision-admin");
    console.log("✅ Admin deleted.");
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
    console.error("provision-admin failed:", err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
