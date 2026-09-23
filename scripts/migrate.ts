import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const path = process.env.APP_DB_PATH ?? "data/charging.sqlite3";
mkdirSync(dirname(path), { recursive: true });
const database = new Database(path);
database.pragma("foreign_keys = ON");

database.exec(
  "CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
);

const applied = new Set(
  database.prepare("SELECT version FROM schema_versions").all().map((r) => (r as { version: number }).version)
);

const files = readdirSync("migrations")
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

for (const file of files) {
  const version = Number(file.slice(0, 3));
  if (applied.has(version)) continue;
  const tx = database.transaction(() => {
    database.exec(readFileSync(join("migrations", file), "utf8"));
    database.prepare("INSERT INTO schema_versions(version, applied_at) VALUES(?, ?)").run(version, new Date().toISOString());
  });
  tx();
  console.log(`applied migration ${version}: ${file}`);
}

database.close();
