import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

export function openDatabase(path = process.env.APP_DB_PATH ?? "data/charging.sqlite3"): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** 按文件名顺序执行 migrations/ 下全部 SQL，并在 schema_versions 记账。 */
export function migrate(db: DB, migrationsDir = join(process.cwd(), "migrations")): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_versions").all().map((r) => (r as { version: number }).version),
  );
  const files = readdirSync(migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const done: number[] = [];
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (applied.has(version)) continue;
    const tx = db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.prepare("INSERT INTO schema_versions(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    });
    tx();
    done.push(version);
  }
  return done;
}

export function openMigratedDatabase(path?: string): DB {
  const db = openDatabase(path);
  migrate(db);
  return db;
}
