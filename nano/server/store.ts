// Durable JSON store (single writer). BigInt-safe (ops carry bigint amounts)
// and atomic (temp + rename). Files live in $DATA_DIR (default: ./data) so they
// survive restarts and can be pointed at a shared/durable volume. Swap this
// module for SQLite/Postgres later without touching callers.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "../core/json";
import { atomicWrite } from "./fsutil";

function dir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

export function loadJson<T>(name: string): T | null {
  try {
    return parse<T>(fs.readFileSync(path.join(dir(), name), "utf-8"));
  } catch {
    return null;
  }
}

export function saveJson(name: string, value: unknown): void {
  fs.mkdirSync(dir(), { recursive: true });
  atomicWrite(path.join(dir(), name), stringify(value));
}