// Preinstall guard: this project is pnpm-only. npm/yarn misread pnpm's node_modules
// layout and can corrupt the tree, so block them here. Network-free — reads the
// package manager from the user-agent the manager itself sets.
const ua = process.env.npm_config_user_agent || "";

// Only block when we can positively identify a non-pnpm manager; never false-block.
if (ua && !ua.startsWith("pnpm")) {
  const tool = ua.split("/")[0];
  console.error(
    `\n✗ This project is pnpm-only, but you ran it with "${tool}".\n` +
      `  Use pnpm instead:  corepack enable && pnpm install\n` +
      `  (see the "packageManager" field in package.json)\n`,
  );
  process.exit(1);
}
