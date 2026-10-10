import { getDatabase, closeDatabase } from "../lib/db/client";
import { migrateDatabase } from "../lib/db/migrate";

async function main() {
  const added = await migrateDatabase(getDatabase());
  console.log(added.length ? `Database ready. Applied: ${added.join(", ")}` : "Database ready. All migrations are already applied.");
}
main().catch(() => {
  // Do not print driver errors: they can contain connection details or SQL parameters.
  console.error("Database migration failed. Check DATABASE_URL, network access, database privileges and migration history. No connection credentials were printed.");
  process.exitCode = 1;
}).finally(closeDatabase);
