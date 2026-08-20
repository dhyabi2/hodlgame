// Durable store. Async API so the same code runs on a local filesystem (default,
// for tests/self-host) or Vercel Postgres (STORE=postgres + POSTGRES_URL).
// BigInt-safe via core/json. Swap in another DB by reimplementing load/save.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "../core/json";
import { atomicWrite } from "./fsutil";

function dir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

// --- Vercel Postgres backend ---
let pgSql: any = null;
let pgChecked = false;

async function getPg(): Promise<any | null> {
  if (pgChecked) return pgSql;
  pgChecked = true;
  if (process.env.STORE !== "postgres") return null;
  try {
    const { sql } = require("@vercel/postgres");
    await sql`CREATE TABLE IF NOT EXISTS holdfun_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    pgSql = sql;
  } catch {
    pgSql = null;
  }
  return pgSql;
}

export async function loadJson<T>(name: string): Promise<T | null> {
  const s = await getPg();
  if (s) {
    try {
      const r = await s`SELECT value FROM holdfun_kv WHERE key = ${name}`;
      return r.rowCount > 0 ? parse<T>(r.rows[0].value) : null;
    } catch {
      return null;
    }
  }
  try {
    return parse<T>(await fs.promises.readFile(path.join(dir(), name + ".json"), "utf-8"));
  } catch {
    return null;
  }
}

export async function saveJson(name: string, value: unknown): Promise<void> {
  const s = await getPg();
  if (s) {
    await s`
      INSERT INTO holdfun_kv (key, value) VALUES (${name}, ${stringify(value)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    return;
  }
  await fs.promises.mkdir(dir(), { recursive: true });
  atomicWrite(path.join(dir(), name + ".json"), stringify(value));
}