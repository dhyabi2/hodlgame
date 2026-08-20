// Durable store. Async API so the same code runs on a local filesystem (default,
// for tests/self-host) or Vercel KV (STORE=kv + KV_REST_API_URL/TOKEN).
// BigInt-safe via core/json. Swap in another DB by reimplementing load/save.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "../core/json";
import { atomicWrite } from "./fsutil";

function dir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

// --- Vercel KV backend ---
let kvClient: any = null;
let kvChecked = false;

async function getKv(): Promise<any | null> {
  if (kvChecked) return kvClient;
  kvChecked = true;
  if (process.env.STORE !== "kv") return null;
  try {
    kvClient = require("@vercel/kv").kv;
  } catch {
    kvClient = null;
  }
  return kvClient;
}

export async function loadJson<T>(name: string): Promise<T | null> {
  const kv = await getKv();
  if (kv) {
    try {
      const v = await kv.get(`holdfun:${name}`);
      return typeof v === "string" ? parse<T>(v) : null;
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
  const kv = await getKv();
  if (kv) {
    await kv.set(`holdfun:${name}`, stringify(value));
    return;
  }
  await fs.promises.mkdir(dir(), { recursive: true });
  atomicWrite(path.join(dir(), name + ".json"), stringify(value));
}