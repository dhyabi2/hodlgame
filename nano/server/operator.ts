// Operator core (no HTTP): indexer + sweep. Shared by the self-host operator
// server and the Vercel cron route.

import { MultiIndexer } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { tokenPoolKeys } from "./custody";
import { receivePoolsMulti, settlePoolNetted } from "./sweep";
import { creditedBuys } from "./reconcile";
import { analyze } from "./analytics";
import { commitResolver } from "./commits";
import { loadNanoRpcKey } from "../lib/rpc";
import { discoverAccounts } from "../indexer/discovery";
import { ANCHOR_ADDRESS } from "../core/anchor";
import { loadBlob, saveBlob } from "./store";
import { StoreBlockCache } from "./sharedCache";

export function watched(): string[] {
  const raw = process.env.WATCHED_ACCOUNTS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Shared, append-only watch-list. Live anchor discovery is NON-DETERMINISTIC —
// it walks the anchor's pending/receive counterparties, which are node-local in
// Nano and differ per RPC backend/region, so two requests can discover DIFFERENT
// account sets and therefore replay to DIFFERENT holder counts / poolXno /
// trades (the observed flicker). A monotonic UNION in the durable store fixes
// this: every request folds live discovery into the stored set and writes the
// grown union back, so the watch-list only ever grows and CONVERGES to the
// complete set across all instances. This is NOT the per-instance TTL cache the
// old comment warned against (that diverged BECAUSE it was per-instance and
// could shrink) — it's shared and append-only, so it never goes stale (a stale
// value can only be MISSING an account, which the next request that sees it
// adds) and never drops one. A wrongly-INCLUDED account is impossible anyway
// (blocks are self-verifying; a non-participant contributes no valid ops), so
// union-only growth is safe.
const WATCH_KEY = "watched-accounts";
const HEX_ADDR = /^(nano|xrb)_[13][0-9a-z]{59}$/;

/** The PERSISTED watch list. Unlike `watchedAccounts()` this does no live
 * discovery, so it is stable call-to-call — which is what a cache fingerprint
 * needs (a set that flickers with RPC weather produces a key that never
 * repeats, and therefore a cache that never hits). */
export async function storedWatched(): Promise<string[]> {
  return loadStoredWatched();
}

async function loadStoredWatched(): Promise<string[]> {
  try {
    const raw = await loadBlob(WATCH_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((a) => typeof a === "string" && HEX_ADDR.test(a)) : [];
  } catch { return []; }
}

/** Fold `accounts` into the stored watch-list; write back only if it grew.
 * Best-effort — never throws, never blocks the caller on a store error. */
export async function persistWatched(accounts: string[]): Promise<void> {
  try {
    const stored = new Set(await loadStoredWatched());
    let grew = false;
    for (const a of accounts) if (HEX_ADDR.test(a) && !stored.has(a)) { stored.add(a); grew = true; }
    if (grew) await saveBlob(WATCH_KEY, JSON.stringify([...stored].sort()));
  } catch {}
}

// Anchor-derived discovery (core/anchor.ts): a live, uncached 2-hop walk of
// the public ANCHOR account's chain history (core/anchor.ts) — the env list
// is additive during migration and the fallback when discovery is
// unreachable. Once every legacy account has been anchor-bootstrapped,
// WATCHED_ACCOUNTS can be deleted.
//
// Deliberately NOT cached (in memory or in the durable store). This ran on
// Vercel with a module-level TTL cache before — since each serverless
// instance has its own isolated memory, a freshly-launched coin whose
// creator only ONE instance's cache had discovered would vanish and
// reappear depending on which instance handled a given request, entirely
// independent of chain state.
//
// Queried TWICE per call — once with the rpc.nano.to API key, once without —
// and the results are unioned. Root-caused live (2026-08-22): the exact same
// request, at the exact same moment, returns DIFFERENT counterparty data
// depending on whether the key is sent — rpc.nano.to's keyed tier lagged
// behind its own public/keyless tier for a specific account, silently
// dropping a real, chain-confirmed coin from discovery. Both calls hit only
// the two endpoints the strict RPC rule (lib/rpc.ts) already permits — this
// isn't a new endpoint, just refusing to trust either single response as
// complete. Blocks are self-verifying (ed25519-blake2b, core/blockVerify.ts),
// so a wrongly-INCLUDED account is impossible; the only real risk was ever a
// wrongly-EXCLUDED one, which unioning eliminates as long as at least one of
// the two calls has current data.
export async function watchedAccounts(): Promise<string[]> {
  const env = watched();
  const [keyed, keyless, stored] = await Promise.allSettled([
    discoverAccounts(new NanoRpcSource(loadNanoRpcKey()), ANCHOR_ADDRESS),
    discoverAccounts(new NanoRpcSource(""), ANCHOR_ADDRESS),
    loadStoredWatched(),
  ]);
  const users = new Set(env);
  // The persisted union is the stable base — nothing ever disappears from it.
  if (stored.status === "fulfilled") for (const u of stored.value) users.add(u);
  if (keyed.status === "fulfilled") for (const u of keyed.value.users) users.add(u);
  if (keyless.status === "fulfilled") for (const u of keyless.value.users) users.add(u);
  const list = [...users].sort();
  // Grow the shared set with anything newly discovered (fire-and-forget).
  const storedCount = stored.status === "fulfilled" ? stored.value.length : 0;
  if (list.length > storedCount) void persistWatched(list);
  return list;
}

export async function indexer(): Promise<MultiIndexer> {
  const master = process.env.POOL_SEED ?? "";
  const poolKey = (tokenId: string) => (master ? tokenPoolKeys(master, tokenId).publicKey : null);
  const commit = await commitResolver();
  const idx = new MultiIndexer(
    new NanoRpcSource(loadNanoRpcKey(), new StoreBlockCache()),
    () => ({ name: "", symbol: "", decimals: 6, image: "" }),
    commit,
    poolKey
  );
  await idx.sync(await watchedAccounts());
  return idx;
}

let sweeping = false;

export async function runSweep(onlyToken: string | null) {
  if (sweeping) return { skipped: "sweep already in progress" };
  sweeping = true;
  try {
    const masterSeed = process.env.POOL_SEED;
    if (!masterSeed) return { error: "POOL_SEED not set" };
    const key = loadNanoRpcKey();
    const idx = await indexer();
    const events = await idx.collectEvents(await watchedAccounts());
    const credits = creditedBuys(events);
    const { state: replayed } = analyze(events);

    // Direct-Settlement tokens have NO pool account and settle wallet-to-wallet
    // at sell time — the sweep must never touch them.
    const known = [...idx.getState().entries()].filter(([, s]) => !s.direct).map(([id]) => id);
    let targets = onlyToken ? (known.includes(onlyToken) ? [onlyToken] : []) : known;

    // Custody consistency: the chain-derived pool (what the deterministic
    // ledger validated deposits against) must be the custody-derived account
    // (what we can sign for). A mismatch means the creator seeded a pool we
    // don't hold — never service it: receives/payouts would either fail or
    // pay from the wrong account.
    const chainPools = idx.getChainPools();
    const mismatched: string[] = [];
    targets = targets.filter((tokenId) => {
      const chainPub = chainPools.get(tokenId);
      if (chainPub && chainPub !== tokenPoolKeys(masterSeed, tokenId).publicKey.toLowerCase()) {
        mismatched.push(tokenId);
        return false;
      }
      return true;
    });
    if (mismatched.length) console.warn("skipping non-custody pools:", mismatched.map((t) => t.slice(0, 12)).join(", "));

    const received = await receivePoolsMulti(key, masterSeed, targets);

    // Chain-derived settlement (settled.ts): sells + refunds net per recipient
    // against the pool's own outgoing history — no private ledgers, safe under
    // crashes and concurrent sweepers.
    const paid: string[] = [];
    let skipped = 0;
    for (const tokenId of targets) {
      const pool = tokenPoolKeys(masterSeed, tokenId);
      const r = await settlePoolNetted(key, pool, tokenId, replayed.get(tokenId)?.xnoWithdrawn ?? new Map(), credits.get(tokenId) ?? new Map());
      paid.push(...r.paid);
      skipped += r.queued;
    }

    return { received, paid, skipped, refunds: [] };
  } finally {
    sweeping = false;
  }
}