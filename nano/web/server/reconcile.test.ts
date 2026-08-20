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

console.log("✅ buy reconciliation tests passed");