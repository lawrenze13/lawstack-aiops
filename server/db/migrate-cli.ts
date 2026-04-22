// Standalone CLI: `npm run db:migrate`. Used in dev and in the systemd
// `ExecStartPre` step in production.

// Signal client.ts to skip the boot reconciler import — the CLI only needs
// the DB schema wired up, not the full worker module graph. Must be set
// before the first import of anything that pulls in client.ts.
process.env.AIOPS_CLI = "1";

async function main(): Promise<void> {
  const { runMigrations } = await import("./migrate");
  runMigrations();
  // eslint-disable-next-line no-console
  console.log("✓ migrations applied");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
