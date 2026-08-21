// STRICT RULE: HoldFun Nano uses https://rpc.nano.to EXCLUSIVELY.
// Do NOT add other RPC endpoints, proxies, or work services to this file or
// anywhere else in the codebase. The only permitted fallback is LOCAL CPU
// proof-of-work computation (offline, contacts no one), used when
// work_generate does not answer.
//
// Fetched blocks are still verified locally (indexer/blockSource.ts):
// self-certifying ed25519-blake2b signatures mean the endpoint can omit
// data, never forge it.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

export const NANO_RPC = "https://rpc.nano.to";
export const SEND_DIFFICULTY = "fffffff800000000";
export const RECEIVE_DIFFICULTY = "fffffe0000000000";

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

const TIMEOUT_MS = 30_000;

/** Perform a JSON-RPC call against rpc.nano.to. Throws on error. The single
 * exception: a work_generate that fails or times out falls back to LOCAL CPU
 * computation (nanocurrency.computeWork) — slower, but sovereign and offline. */
export async function nanoRpc(key: string, body: Record<string, unknown>): Promise<any> {
  const payload = { ...body };
  // rpc.nano.to accepts the key in the body and as an Authorization header
  // (no "Bearer" prefix) — per the reference implementation.
  if (key) (payload as any).key = key;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NANO_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: key } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const json = (await res.json()) as any;
    if (json.error) {
      throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
    }
    return json;
  } catch (e: any) {
    // Local PoW fallback — offline, no third party.
    if (body.action === "work_generate" && typeof body.hash === "string") {
      const threshold = typeof body.difficulty === "string" ? body.difficulty : SEND_DIFFICULTY;
      const work = await nanocurrency.computeWork(body.hash, { workThreshold: threshold });
      if (work) return { work, difficulty: threshold, source: "local" };
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
