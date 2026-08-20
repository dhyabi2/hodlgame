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
    const targets = onlyToken ? (known.includes(onlyToken) ? [onlyToken] : []) : known;

    const received = await receivePoolsMulti(key, masterSeed, targets);

    const payouts = onlyToken ? sellPayouts.filter((p) => p.tokenId === onlyToken) : sellPayouts;
    const { paid, skipped } = await payoutSellsMulti(key, masterSeed, payouts, []);

    const refunds: string[] = [];
    for (const tokenId of targets) {
      const pool = tokenPoolKeys(masterSeed, tokenId);
      const poolReceived = await readPoolDeposits(key, pool);
      const owed = computeRefunds(poolReceived, credits.get(tokenId) ?? new Map());
      refunds.push(...(await refundRejectedBuys(key, pool, owed)));
    }

    return { received, paid, skipped, refunds };
  } finally {
    sweeping = false;
  }
}