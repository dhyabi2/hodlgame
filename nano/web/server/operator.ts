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

export function watched(): string[] {
  const raw = process.env.WATCHED_ACCOUNTS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Anchor-derived discovery (core/anchor.ts), cached briefly; the env list is
// additive during migration and the fallback when discovery is unreachable.
// Once every legacy account has been anchor-bootstrapped, WATCHED_ACCOUNTS
// can be deleted.
let discoveryCache: { at: number; users: string[] } | null = null;
const DISCOVERY_TTL_MS = 30_000;

export async function watchedAccounts(): Promise<string[]> {
  const env = watched();
  if (!discoveryCache || Date.now() - discoveryCache.at >= DISCOVERY_TTL_MS) {
    try {
      const d = await discoverAccounts(new NanoRpcSource(loadNanoRpcKey()), ANCHOR_ADDRESS);
      discoveryCache = { at: Date.now(), users: d.users };
    } catch {
      // discovery unreachable → env-only this round
    }
  }
  return [...new Set([...(discoveryCache?.users ?? []), ...env])].sort();
}

export async function indexer(): Promise<MultiIndexer> {
  const master = process.env.POOL_SEED ?? "";
  const poolKey = (tokenId: string) => (master ? tokenPoolKeys(master, tokenId).publicKey : null);
  const commit = await commitResolver();
  const idx = new MultiIndexer(
    new NanoRpcSource(loadNanoRpcKey()),
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
    const { sellPayouts } = analyze(events);

    const known = [...idx.getState().keys()];
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
      const r = await settlePoolNetted(key, pool, tokenId, sellPayouts, credits.get(tokenId) ?? new Map());
      paid.push(...r.paid);
      skipped += r.queued;
    }

    return { received, paid, skipped, refunds: [] };
  } finally {
    sweeping = false;
  }
}