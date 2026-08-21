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
  // Private store: content is read back server-side (with the token) via get()
  // and streamed by our own routes, so blobs never need to be publicly fetchable.
  await put(pathname, value, { access: "private" as any, addRandomSuffix: false, allowOverwrite: true, contentType });
}
async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import("@vercel/blob");
  const r: any = await get(pathname, { access: "private" as any });
  if (!r || r.statusCode !== 200) return null;
  return await new Response(r.stream).text();
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
async function upstashCmd(cmd: unknown[], u: { url: string; token: string }): Promise<any> {
  const res = await fetch(u.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${cmd[0]} failed (${res.status})`);
  const j = (await res.json()) as { result?: any };
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

// ── image garbage collection support (orphan cleanup) ────────────────────────
// List every stored image id (32-hex) with its age in ms (-1 if unknown), and
// delete one by id. Backend-specific because each stores the key differently.
const HEX32 = /^[0-9a-f]{32}$/;

export async function listImageIds(): Promise<{ id: string; ageMs: number }[]> {
  const now = Date.now();
  const u = upstash();
  if (u) {
    const out: { id: string; ageMs: number }[] = [];
    let cursor = "0";
    do {
      const r = await upstashCmd(["SCAN", cursor, "MATCH", "holdfun:img:*", "COUNT", "300"], u);
      cursor = String(r?.[0] ?? "0");
      for (const key of (r?.[1] ?? []) as string[]) {
        const id = key.replace(/^holdfun:img:/, "");
        if (!HEX32.test(id)) continue;
        let ageMs = -1;
        try { const t = JSON.parse((await upstashCmd(["GET", key], u)) ?? "{}")?.t; if (typeof t === "number") ageMs = now - t; } catch {}
        out.push({ id, ageMs });
      }
    } while (cursor !== "0");
    return out;
  }
  if (blobEnabled()) {
    const { list } = await import("@vercel/blob");
    const out: { id: string; ageMs: number }[] = [];
    let cursor: string | undefined;
    do {
      const r: any = await list({ prefix: "blob/img_", cursor, limit: 1000 });
      for (const b of r.blobs) {
        const id = String(b.pathname).replace(/^blob\/img_/, "");
        if (HEX32.test(id)) out.push({ id, ageMs: b.uploadedAt ? now - new Date(b.uploadedAt).getTime() : -1 });
      }
      cursor = r.cursor;
    } while (cursor);
    return out;
  }
  try {
    const files = await fs.promises.readdir(dir());
    const out: { id: string; ageMs: number }[] = [];
    for (const f of files) {
      const m = f.match(/^img_([0-9a-f]{32})\.blob$/);
      if (!m) continue;
      let ageMs = -1;
      try { ageMs = now - (await fs.promises.stat(path.join(dir(), f))).mtimeMs; } catch {}
      out.push({ id: m[1], ageMs });
    }
    return out;
  } catch { return []; }
}

export async function delImage(id: string): Promise<void> {
  if (!HEX32.test(id)) return;
  const name = `img:${id}`;
  const u = upstash();
  if (u) { await upstashCmd(["DEL", `holdfun:${name}`], u); return; }
  if (blobEnabled()) {
    const { list, del } = await import("@vercel/blob");
    const path0 = `blob/${blobKey(name)}`;
    const r: any = await list({ prefix: path0, limit: 1 });
    const b = r.blobs.find((x: any) => x.pathname === path0);
    if (b) await del(b.url);
    return;
  }
  try { await fs.promises.unlink(blobFile(name)); } catch {}
}