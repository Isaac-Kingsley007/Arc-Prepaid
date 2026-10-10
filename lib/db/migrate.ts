import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Database } from "./client";

export async function migrateDatabase(db: Database, directory = fileURLToPath(new URL("../../db/migrations/", import.meta.url))): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(files.map(async (name) => {
    const source = await readFile(join(directory, name), "utf8");
    // Normalize line endings so Windows checkouts have the same checksum as Linux.
    const sql = source.replace(/\r\n/g, "\n");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  return db.begin(async (tx) => {
    // Transaction-scoped advisory lock works with Neon's transaction pooler.
    await tx`SELECT pg_advisory_xact_lock(5042002, 3009)`;
    await tx`CREATE TABLE IF NOT EXISTS prepaid_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const applied = await tx<{ name: string; checksum: string }[]>`SELECT name, checksum FROM prepaid_migrations`;
    for (const row of applied) {
      if (!migrations.some((migration) => migration.name === row.name && migration.checksum === row.checksum)) {
        throw new Error("Applied database migrations differ from this checkout; restore them and add a new migration");
      }
    }
    const added: string[] = [];
    for (const migration of migrations) {
      if (applied.some((row) => row.name === migration.name)) continue;
      // Only committed local migration SQL reaches unsafe(); user values never do.
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO prepaid_migrations(name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
      added.push(migration.name);
    }
    return added;
  });
}
