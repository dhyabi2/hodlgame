// Operator core (no HTTP): indexer + sweep. Shared by the self-host operator
// server and the Vercel cron route.

import { MultiIndexer } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import { tokenPoolKeys } from "./custody";
import { receivePoolsMulti, payoutSellsMulti, readPoolDeposits, refundRejectedBuys } from "./sweep";
import { creditedBuys, computeRefunds } from "./reconcile";
import { analyze } from "./analytics";
import { commitResolver } from "./commits";
import { loadNanoRpcKey } from "../lib/rpc";

export function watched(): string[] {
  const raw = process.env.WATCHED_ACCOUNTS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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
  await idx.sync(watched());
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
    const events = await idx.collectEvents(watched());
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

    const serviceable = new Set(targets);
    const payouts = sellPayouts.filter((p) => serviceable.has(p.tokenId));
    const { paid, skipped } = await payoutSellsMulti(key, masterSeed, payouts, []);

    const refunds: string[] = [];
    for (const tokenId of targets) {
      const pool = tokenPoolKeys(masterSeed, tokenId);
      const poolReceived = await readPoolDeposits(key, pool, tokenId);
      const owed = computeRefunds(poolReceived, credits.get(tokenId) ?? new Map());
      refunds.push(...(await refundRejectedBuys(key, pool, tokenId, owed)));
    }

    return { received, paid, skipped, refunds };
  } finally {
    sweeping = false;
  }
}