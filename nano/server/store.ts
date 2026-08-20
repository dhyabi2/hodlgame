// Durable store. Uses SQLite (node:sqlite, zero-dependency) by default — a
// single key/value table in $DATA_DIR/holdfun.db — with an atomic JSON-file
// fallback (STORE=json or if SQLite is unavailable). BigInt-safe via core/json.
// Swap in Postgres/D1 later by replacing the two functions below.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "../core/json";
import { atomicWrite } from "./fsutil";

function dir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

let sqlite: { prepare: (sql: string) => any } | null | undefined;

function getDb(): { prepare: (sql: string) => any } | null {
  if (process.env.STORE === "json") return null;
  if (sqlite !== undefined) return sqlite;
  try {
    // node:sqlite is built into Node 22.5+. require() keeps this side-effect-free
    // at type-check time (no @types/node upgrade needed).
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };
    fs.mkdirSync(dir(), { recursive: true });
    const db = new DatabaseSync(path.join(dir(), "holdfun.db"));
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sqlite = db;
    return db;
  } catch {
    sqlite = null;
    return null;
  }
}

export function loadJson<T>(name: string): T | null {
  const db = getDb();
  if (db) {
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(name) as { value?: string } | undefined;
      return row?.value != null ? parse<T>(row.value) : null;
    } catch {
      return null;
    }
  }
  try {
    return parse<T>(fs.readFileSync(path.join(dir(), name + ".json"), "utf-8"));
  } catch {
    return null;
  }
}

export function saveJson(name: string, value: unknown): void {
  const db = getDb();
  if (db) {
    db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(name, stringify(value));
    return;
  }
  fs.mkdirSync(dir(), { recursive: true });
  atomicWrite(path.join(dir(), name + ".json"), stringify(value));
}