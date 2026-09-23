import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { migrate } from "../src/db.js";

/** 每个用例独立的内存库（better-sqlite3 的 :memory: 连接各自独立）。 */
export function newMemoryDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function row(db: DB, sql: string, ...params: unknown[]): Record<string, unknown> {
  const r = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`查询无结果: ${sql}`);
  return r;
}

export function rows(db: DB, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}
