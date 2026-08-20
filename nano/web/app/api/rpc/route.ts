import { NextResponse } from "next/server";
import { nanoRpc, loadNanoRpcKey } from "../../../lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whitelist of Nano RPC actions the app needs. Anything else is rejected so
// the paid RPC key can't be used as a general-purpose proxy from the browser.
const ALLOWED = new Set([
  "account_info",
  "account_history",
  "blocks_info",
  "block_info",
  "pending",
  "work_generate",
  "process",
]);

// Simple in-memory per-IP rate limiter (sliding window).
const hits = new Map<string, number[]>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  // Opportunistically evict stale keys so a spoofed-IP flood can't grow `hits`
  // without bound (best-effort — per serverless instance).
  if (hits.size > 10_000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

/** Proxy to rpc.nano.to — keeps the API key server-side, whitelisted + throttled. */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action: unknown = body?.action;
  if (typeof action !== "string" || !ALLOWED.has(action)) {
    return NextResponse.json({ error: "action not allowed" }, { status: 403 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if ((action === "work_generate" && !rateLimit(ip + ":work", 20, 60_000)) ||
      (action === "process" && !rateLimit(ip + ":process", 120, 60_000))) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  try {
    const result = await nanoRpc(loadNanoRpcKey(), body);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}