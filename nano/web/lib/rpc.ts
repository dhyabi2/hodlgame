// Vendor-independent RPC access.
//
// Chain reads/writes fan out over an ordered endpoint list (NANO_RPC_URLS,
// comma-separated) with per-endpoint circuit breakers, so no single vendor's
// death or billing stops the system. Returned blocks are verified locally by
// the block source (self-certifying: ed25519-blake2b signatures), so an
// untrusted endpoint can at worst OMIT data, never forge it. work_generate
// falls back to local CPU computation (nanocurrency.computeWork) when no
// endpoint serves it — slower, but sovereign.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

export const SEND_DIFFICULTY = "fffffff800000000";
export const RECEIVE_DIFFICULTY = "fffffe0000000000";

const DEFAULT_URLS = [
  "https://rpc.nano.to",
  "https://node.somenano.com/proxy",
  "https://rainstorm.city/api",
  "http://localhost:7076",
];

export function rpcUrls(): string[] {
  const env = (process.env.NANO_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return env.length ? env : DEFAULT_URLS;
}

/** Kept for back-compat: the primary endpoint. */
export const NANO_RPC = DEFAULT_URLS[0];

/** Load the rpc.nano.to API key from env or the local (gitignored) .keys.json. */
export function loadNanoRpcKey(): string {
  if (process.env.NANO_RPC_KEY) return process.env.NANO_RPC_KEY;
  try {
    const keys = JSON.parse(fs.readFileSync(".keys.json", "utf-8"));
    return keys.nanoRpcKey ?? "";
  } catch {
    return "";
  }
}

// Per-endpoint circuit breaker: after FAILS_TO_OPEN consecutive failures an
// endpoint is skipped for COOLDOWN_MS, then retried.
const FAILS_TO_OPEN = 3;
const COOLDOWN_MS = 60_000;
const breaker = new Map<string, { fails: number; openedAt: number }>();

function available(url: string): boolean {
  const b = breaker.get(url);
  if (!b || b.fails < FAILS_TO_OPEN) return true;
  if (Date.now() - b.openedAt > COOLDOWN_MS) {
    breaker.delete(url); // half-open: allow a retry
    return true;
  }
  return false;
}
function recordFail(url: string) {
  const b = breaker.get(url) ?? { fails: 0, openedAt: 0 };
  b.fails++;
  if (b.fails >= FAILS_TO_OPEN) b.openedAt = Date.now();
  breaker.set(url, b);
}
function recordOk(url: string) {
  breaker.delete(url);
}

/** Errors that are real answers (don't fail over to another endpoint). */
function isSemanticError(err: string): boolean {
  return /not found|not_found|insufficient balance|fork|old block|gap /i.test(err);
}

const TIMEOUT_MS = 15_000;

async function callOne(url: string, key: string, body: Record<string, unknown>): Promise<any> {
  const payload = { ...body };
  // The API key belongs to rpc.nano.to only — never leak it to other hosts.
  const useKey = key && url.includes("rpc.nano.to");
  if (useKey) (payload as any).key = key;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(useKey ? { Authorization: key } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return (await res.json()) as any;
  } finally {
    clearTimeout(t);
  }
}

/** JSON-RPC with endpoint failover. Throws only when every endpoint fails or
 * the first responsive endpoint returns a semantic (real-answer) error. */
export async function nanoRpc(key: string, body: Record<string, unknown>): Promise<any> {
  let lastErr: Error | null = null;

  // Dedicated work server (e.g. nano-work-server) takes precedence for PoW.
  if (body.action === "work_generate" && process.env.NANO_WORK_URL) {
    try {
      const json = await callOne(process.env.NANO_WORK_URL.replace(/\/$/, ""), "", body);
      if (json?.work) return json;
    } catch {
      /* fall through to regular endpoints */
    }
  }

  for (const url of rpcUrls()) {
    if (!available(url)) continue;
    try {
      const json = await callOne(url, key, body);
      if (json?.error) {
        const err = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
        if (isSemanticError(err)) {
          recordOk(url);
          throw new SemanticRpcError(err);
        }
        // Endpoint-specific failure (unknown command, rate limit, …) → next.
        lastErr = new Error(`${url}: ${err}`);
        recordFail(url);
        continue;
      }
      recordOk(url);
      return json;
    } catch (e: any) {
      if (e instanceof SemanticRpcError) throw new Error(e.message);
      lastErr = new Error(`${url}: ${e?.message ?? e}`);
      recordFail(url);
    }
  }

  // Sovereign fallback: compute proof-of-work locally when no endpoint serves it.
  if (body.action === "work_generate" && typeof body.hash === "string") {
    const threshold = typeof body.difficulty === "string" ? body.difficulty : SEND_DIFFICULTY;
    const work = await nanocurrency.computeWork(body.hash, { workThreshold: threshold });
    if (work) return { work, difficulty: threshold, source: "local" };
  }

  throw lastErr ?? new Error("no RPC endpoints configured");
}

class SemanticRpcError extends Error {}
