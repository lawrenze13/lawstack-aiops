// Standalone CLI: `npm run db:migrate`. Used in dev and in the systemd
// `ExecStartPre` step in production.
import { runMigrations } from "./migrate";

runMigrations();
// eslint-disable-next-line no-console
console.log("✓ migrations applied");
