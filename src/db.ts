import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";

/** 按文件名顺序执行 migrations 目录下的 SQL，已应用版本跳过；可在测试中对临时库调用。 */
export function runMigrations(database: DB, migrationsDir = join(process.cwd(), "migrations")) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_versions")
      .all()
      .map((r) => (r as { version: number }).version)
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const tx = database.transaction(() => {
      database.exec(readFileSync(join(migrationsDir, file), "utf8"));
      database
        .prepare("INSERT INTO schema_versions(version, applied_at) VALUES(?, ?)")
        .run(version, new Date().toISOString());
    });
    tx();
  }
}

export function openDatabase(path = process.env.APP_DB_PATH ?? "data/charging.sqlite3"): DB {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}
