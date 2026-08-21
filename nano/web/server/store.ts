// Durable store. Async API so the same code runs on a local filesystem (default,
// for tests/self-host) or Upstash Redis over plain fetch (STORE=upstash +
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). BigInt-safe via core/json.
// No npm SDK / native modules — works on Vercel serverless.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "../core/json";
import { atomicWrite } from "./fsutil";

function dir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

function upstash(): { url: string; token: string } | null {
  // Accept explicit Upstash env vars OR the vars that Vercel's Marketplace
  // "Upstash for Redis" integration auto-injects (KV_REST_API_*). If REST
  // credentials are present the store uses them automatically — no STORE flag
  // needed — so provisioning + connecting the integration is the only step.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (process.env.STORE && process.env.STORE !== "upstash") return null; // explicit opt-out
  return { url: url.replace(/\/$/, ""), token };
}

async function upstashGet(key: string, u: { url: string; token: string }): Promise<string | null> {
  const res = await fetch(`${u.url}/get/${key}`, { headers: { Authorization: `Bearer ${u.token}` } });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: string | null };
  return j.result ?? null;
}

async function upstashSet(key: string, value: string, u: { url: string; token: string }): Promise<void> {
  await fetch(`${u.url}/set/${key}/${encodeURIComponent(value)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${u.token}` },
  });
}

// Vercel Blob backend (used when BLOB_READ_WRITE_TOKEN is present, i.e. a Blob
// store is connected to the project). Lazily imported so neither the tests nor
// the local/self-host paths need the @vercel/blob package. Deterministic
// pathnames (no random suffix, overwrite) make it a plain key→value store.
const blobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const blobKey = (name: string) => name.replace(/[^\w.-]/g, "_");

async function blobPut(pathname: string, value: string, contentType: string): Promise<void> {
  const { put } = await import("@vercel/blob");
  await put(pathname, value, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType });
}
async function blobGet(pathname: string): Promise<string | null> {
  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  const b = blobs.find((x: { pathname: string }) => x.pathname === pathname);
  if (!b) return null;
  const res = await fetch((b as { downloadUrl?: string; url: string }).downloadUrl ?? b.url);
  return res.ok ? await res.text() : null;
}

export async function loadJson<T>(name: string): Promise<T | null> {
  const u = upstash();
  if (u) {
    try {
      const v = await upstashGet(`holdfun:${name}`, u);
      return typeof v === "string" ? parse<T>(v) : null;
    } catch {
      return null;
    }
  }
  if (blobEnabled()) {
    try { const v = await blobGet(`kv/${blobKey(name)}.json`); return v ? parse<T>(v) : null; } catch { return null; }
  }
  try {
    return parse<T>(await fs.promises.readFile(path.join(dir(), name + ".json"), "utf-8"));
  } catch {
    return null;
  }
}

export async function saveJson(name: string, value: unknown): Promise<void> {
  const u = upstash();
  if (u) {
    await upstashSet(`holdfun:${name}`, stringify(value), u);
    return;
  }
  if (blobEnabled()) {
    await blobPut(`kv/${blobKey(name)}.json`, stringify(value), "application/json");
    return;
  }
  await fs.promises.mkdir(dir(), { recursive: true });
  atomicWrite(path.join(dir(), name + ".json"), stringify(value));
}

// Blobs (e.g. base64 images) go through the Upstash *command* API with the
// value in the POST body, not the URL path — a base64 image is far too large to
// fit in a URL, so `upstashSet` (value-in-URL) cannot carry it. Locally it falls
// back to a file. Keys are sanitized to a safe filename for the fs path.
async function upstashCmd(cmd: unknown[], u: { url: string; token: string }): Promise<string | null> {
  const res = await fetch(u.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${cmd[0]} failed (${res.status})`);
  const j = (await res.json()) as { result?: string | null };
  return j.result ?? null;
}
const blobFile = (name: string) => path.join(dir(), name.replace(/[^\w.-]/g, "_") + ".blob");

export async function saveBlob(name: string, value: string): Promise<void> {
  const u = upstash();
  if (u) { await upstashCmd(["SET", `holdfun:${name}`, value], u); return; }
  if (blobEnabled()) { await blobPut(`blob/${blobKey(name)}`, value, "text/plain"); return; }
  await fs.promises.mkdir(dir(), { recursive: true });
  atomicWrite(blobFile(name), value);
}

export async function loadBlob(name: string): Promise<string | null> {
  const u = upstash();
  if (u) {
    try { return await upstashCmd(["GET", `holdfun:${name}`], u); } catch { return null; }
  }
  if (blobEnabled()) {
    try { return await blobGet(`blob/${blobKey(name)}`); } catch { return null; }
  }
  try { return await fs.promises.readFile(blobFile(name), "utf-8"); } catch { return null; }
}