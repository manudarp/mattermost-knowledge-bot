import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "migrations");

mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function runMigrations(): void {
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pendingFiles = files.filter((f) => !applied.has(f));
  if (pendingFiles.length === 0) return;

  // Table rebuilds (CREATE new / copy / DROP old / RENAME) would fire ON DELETE
  // CASCADE on referencing tables. foreign_keys can't be toggled inside a
  // transaction, so switch it off around the whole batch and verify afterwards.
  db.pragma("foreign_keys = OFF");
  try {
    for (const file of pendingFiles) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const tx = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
      });
      tx();
      logger.info({ migration: file }, "applied migration");
    }
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) logger.warn({ violations }, "foreign_key_check_failed_after_migrations");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// Run on module load so repository modules can prepare statements at top level
// without racing against an uninitialized schema on first boot.
runMigrations();
