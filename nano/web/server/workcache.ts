// Durable proof-of-work pipeline for the pool chains (viral-PoW design).
//
// A Nano block's work depends ONLY on the previous block hash, and each pool
// chain has a single writer (the operator) — so the work for the NEXT pool
// block can be computed the moment the previous one is signed, long before any
// player asks to withdraw. Entries persist in the durable store, so a payout
// that lands on a fresh serverless instance still finds its work precomputed
// and broadcasts instantly instead of stalling on the (flaky) remote work RPC.
// Every cached nonce is re-validated locally before use — a corrupt or stale
// entry degrades to a normal work_generate call, never to a bad block.

import { nanoRpc, validateWork, SEND_DIFFICULTY } from "../lib/rpc";
import { loadJson, saveJson } from "./store";

const keyFor = (frontier: string) => `work:${frontier.toLowerCase()}`;

/** Work for building on `frontier`: precomputed if available (validated), else
 * generated now. */
export async function cachedWork(rpcKey: string, frontier: string, difficulty: string = SEND_DIFFICULTY): Promise<string> {
  try {
    const row = await loadJson<{ work?: string }>(keyFor(frontier));
    if (row?.work && validateWork(row.work, frontier, difficulty)) return row.work;
  } catch {
    /* cache unavailable → generate */
  }
  return (await nanoRpc(rpcKey, { action: "work_generate", hash: frontier, difficulty })).work;
}

/** Precompute + persist work for building on `frontier` (the hash of a block
 * we just broadcast). Best-effort: failure only means the next payout pays the
 * normal work cost. */
export async function precomputeWork(rpcKey: string, frontier: string, difficulty: string = SEND_DIFFICULTY): Promise<void> {
  try {
    const existing = await loadJson<{ work?: string }>(keyFor(frontier));
    if (existing?.work && validateWork(existing.work, frontier, difficulty)) return;
    const work = (await nanoRpc(rpcKey, { action: "work_generate", hash: frontier, difficulty })).work;
    if (validateWork(work, frontier, difficulty)) await saveJson(keyFor(frontier), { work, t: Date.now() });
  } catch {
    /* best-effort */
  }
}
