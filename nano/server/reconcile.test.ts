import { strict as assert } from "node:assert";
import { creditedBuys, computeRefunds } from "./reconcile";
import type { IndexedEvent } from "../indexer/multiIndexer";
import { tokenIdFromLaunchHash } from "../core/token";

const TA = tokenIdFromLaunchHash("a".repeat(64));
const CREATOR = "nano_creator";
const ALICE = "nano_alice";

function ev(tokenId: string, op: any, sender: string, height: bigint): IndexedEvent {
  return { tokenId, op, sender, height, hash: "h" + height };
}

// A launched+seeded token, then a rejected buy (slippage) and a valid buy.
const events: IndexedEvent[] = [
  ev(TA, { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, CREATOR, 1n),
  ev(TA, { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, CREATOR, 2n),
  // rejected: minTokens absurdly high → slippage
  ev(TA, { kind: "buy", xno: 100_000_000n, minTokens: 10n ** 30n }, ALICE, 3n),
  // valid buy
  ev(TA, { kind: "buy", xno: 50_000_000n, minTokens: 0n }, ALICE, 4n),
];

const credits = creditedBuys(events);

// 1. Only the valid buy is credited (rejected buy not counted).
{
  const alice = credits.get(TA)!;
  assert.equal(alice.get(ALICE), 50_000_000n, "only the valid buy xno credited");
}

// 2. Rejected buy xno is refunded: poolReceived 150m, credited 50m → refund 100m.
{
  const got = new Map<string, bigint>([[ALICE, 150_000_000n]]);
  const refunds = computeRefunds(got, credits.get(TA)!);
  assert.equal(refunds.get(ALICE), 100_000_000n, "rejected 100m refunded");
}

// 3. A sender who never sent XNO is never refunded (anti-drain).
{
  const got = new Map<string, bigint>([["nano_evil", 0n]]);
  const refunds = computeRefunds(got, credits.get(TA)!);
  assert.ok(!refunds.has("nano_evil"), "no refund to a non-depositor");
}

// 4. Exact send (no loss, no reject) → no refund.
{
  const got = new Map<string, bigint>([[ALICE, 50_000_000n]]);
  const refunds = computeRefunds(got, credits.get(TA)!);
  assert.equal(refunds.size, 0, "fully-credited deposits refund nothing");
}

// 5. The creator's seed deposit is credited by the seedLiq op — the sweep must
//    NOT refund it back out of the pool.
{
  const creator = credits.get(TA)!;
  assert.equal(creator.get(CREATOR), 1_000_000_000n, "seedLiq xno credited to creator");
  const got = new Map<string, bigint>([[CREATOR, 1_000_000_000n]]);
  const refunds = computeRefunds(got, creator);
  assert.ok(!refunds.has(CREATOR), "seed deposit never refunded");
}

// 6. REGRESSION (deferred-but-valid buy): a buy that sorts BEFORE its token's
//    seed is deferred by the consensus fixpoint and applied once liquidity
//    exists. Reconciliation must credit it exactly as consensus does — a naive
//    single pass would treat it as rejected and refund its XNO even though the
//    buyer already holds the minted tokens (double-pay / pool drain).
{
  const deferred: IndexedEvent[] = [
    ev(TA, { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, CREATOR, 1n),
    // buy at height 2 sorts BEFORE the seed at height 3 → deferred until seeded
    ev(TA, { kind: "buy", xno: 50_000_000n, minTokens: 0n }, ALICE, 2n),
    ev(TA, { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, CREATOR, 3n),
  ];
  const cr = creditedBuys(deferred).get(TA)!;
  assert.equal(cr.get(ALICE), 50_000_000n, "deferred-but-valid buy is credited (no phantom refund)");
  const got = new Map<string, bigint>([[ALICE, 50_000_000n]]);
  assert.equal(computeRefunds(got, cr).size, 0, "a deferred-then-applied buy is never refunded");
}

console.log("✅ buy reconciliation tests passed");