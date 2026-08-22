import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { poolOutgoingByRecipient, entitlementsFor, netObligations } from "./settled";
import type { NanoBlock } from "../indexer/blockSource";

function addr(seedChar: string): { address: string; pub: string } {
  const sk = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  const pub = nanocurrency.derivePublicKey(sk);
  return { address: nanocurrency.deriveAddress(pub, { useNanoPrefix: true }), pub };
}
const ALICE = addr("1");
const BOB = addr("2");
const TOKEN = "ab".repeat(16);

function send(link: string, amount: string, h: string): NanoBlock {
  return { account: "nano_pool", hash: h, previous: "0".repeat(64), link, representative: "r", height: 1n, amount, subtype: "send" };
}

async function main() {
  // 1. Outgoing map: sends sum per recipient; receives/non-sends ignored.
  {
    const blocks: NanoBlock[] = [
      send(ALICE.pub, "100", "h1"),
      send(ALICE.pub, "50", "h2"),
      send(BOB.pub, "7", "h3"),
      { ...send(ALICE.pub, "999", "h4"), subtype: "receive" }, // not a send
    ];
    const out = poolOutgoingByRecipient(blocks);
    assert.equal(out.get(ALICE.address), 150n, "sends sum per recipient");
    assert.equal(out.get(BOB.address), 7n);
    assert.equal(out.size, 2);
  }

  // 2. Entitlements: cumulative WITHDRAWN credit + refunds net per recipient.
  //    (Sells alone entitle nothing — only an explicit withdraw op does.)
  {
    const withdrawn = new Map([
      [ALICE.address, 130n], // withdrew credit from two sells
      ["nano_zero", 0n],     // zero entries are ignored
    ]);
    const refunds = new Map([[ALICE.address, 20n], [BOB.address, 5n]]);
    const ent = entitlementsFor(withdrawn, refunds);
    assert.equal(ent.get(ALICE.address), 150n, "withdrawn + refund combined");
    assert.equal(ent.get(BOB.address), 5n, "refund-only recipient entitled");
    assert.equal(ent.has("nano_zero"), false, "zero withdrawn entitles nothing");
  }

  // 3. Netting: partially paid pays the delta; fully paid pays nothing;
  //    over-sent NEVER goes negative or claws back; unpaid pays in full.
  {
    const entitled = new Map([
      [ALICE.address, 150n], // sent 100 → owe 50
      [BOB.address, 5n], // sent 7 (over) → owe 0
      ["nano_carol", 40n], // sent 0 → owe 40
    ]);
    const sent = new Map([
      [ALICE.address, 100n],
      [BOB.address, 7n],
    ]);
    const obs = netObligations(entitled, sent);
    assert.deepEqual(
      obs.map((o) => [o.recipient, o.amountRaw]),
      [
        ...[[ALICE.address, 50n] as const, ["nano_carol", 40n] as const].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      ],
      "deltas only, deterministic order, no negative obligations"
    );
  }

  // 4. Crash/concurrency model: re-deriving after a partial payment converges.
  //    (The broadcast send lands on the pool chain, so `sent` grows and the
  //    same obligation shrinks to zero — no ledger needed.)
  {
    const entitled = new Map([[ALICE.address, 150n]]);
    const before = netObligations(entitled, new Map());
    assert.equal(before[0].amountRaw, 150n);
    const afterBroadcast = netObligations(entitled, new Map([[ALICE.address, 150n]]));
    assert.equal(afterBroadcast.length, 0, "re-derived obligation vanishes once the send is on chain");
  }

  console.log("✅ chain-derived settlement tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
