import { getDatabase, closeDatabase } from "../lib/db/client";

async function main() {
  const db = getDatabase();
  await db`SELECT 1`;
  const rows = await db<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name IN ('prepaid_schedules', 'prepaid_payments', 'prepaid_migrations')`;
  if (rows.length !== 3) throw new Error("Run pnpm db:migrate first");
  console.log("Database connection and all three tables are ready (including migration history).");
}
main().catch(() => {
  console.error("Database check failed. Check DATABASE_URL and run pnpm db:migrate. No connection credentials were printed.");
  process.exitCode = 1;
}).finally(closeDatabase);
