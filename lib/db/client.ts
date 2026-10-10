import "server-only";
import postgres from "postgres";

export type Database = ReturnType<typeof postgres>;

/** Shared Node.js pool. Never import this module into a Client Component. */
export function createDatabase(url: string, max = 3): Database {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Expected a PostgreSQL connection URL");
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error("DATABASE_POOL_MAX must be between 1 and 20");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return postgres(url, {
    max, idle_timeout: 20, connect_timeout: 10,
    onnotice: () => {},
    ssl: local ? false : { rejectUnauthorized: true },
    connection: { application_name: "prepaid", statement_timeout: 15_000 },
    // Numeric/uint256 and bigint columns deliberately retain the driver's string parsing.
  });
}

const shared = globalThis as typeof globalThis & { prepaidDatabase?: Database };
export function getDatabase(): Database {
  if (!shared.prepaidDatabase) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set server-side DATABASE_URL in .env.local before using the database");
    shared.prepaidDatabase = createDatabase(url, Number(process.env.DATABASE_POOL_MAX ?? 3));
  }
  return shared.prepaidDatabase;
}

export async function closeDatabase(): Promise<void> {
  const db = shared.prepaidDatabase;
  shared.prepaidDatabase = undefined;
  if (db) await db.end({ timeout: 5 });
}
