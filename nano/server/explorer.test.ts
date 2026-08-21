import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { replayWithDeltas, classifyLink, attributePoolSends } from "./explorer";
import type { IndexedEvent } from "../indexer/multiIndexer";
import type { NanoBlock } from "../indexer/blockSource";
import type { SellPayout } from "./analytics";
import { encodeOpLink } from "../core/oplink";
import { encodeFragLinks } from "../core/fraglink";
import { immutableAnchorLink } from "../core/metaAnchor";
import { ANCHOR_PUB, poolHelloRepAddress } from "../core/anchor";
import { commitLink } from "../core/commit";
import { tokenIdFromLaunchHash } from "../core/token";

const HASH_A = "a".repeat(64);
const TOKEN = tokenIdFromLaunchHash(HASH_A);
const CREATOR = "nano_creator";
const ALICE = "nano_alice";

function addr(seedChar: string): { address: string; pub: string } {
  const sk = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  const pub = nanocurrency.derivePublicKey(sk);
  return { address: nanocurrency.deriveAddress(pub, { useNanoPrefix: true }), pub };
}

function ev(op: any, sender: string, height: bigint, hash: string): IndexedEvent {
  return { tokenId: TOKEN, op, sender, height, hash };
}

// ── H1: delta replay ────────────────────────────────────────────────────────
{
  const events: IndexedEvent[] = [
    ev({ kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" }, CREATOR, 1n, "h1"),
    ev({ kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, CREATOR, 2n, "h2"),
    ev({ kind: "buy", xno: 100_000_000n, minTokens: 0n }, ALICE, 3n, "h3"),
    // rejected: absurd slippage guard
    ev({ kind: "buy", xno: 100_000_000n, minTokens: 10n ** 30n }, ALICE, 4n, "h4"),
  ];
  const { state, deltas } = replayWithDeltas(events);

  const launch = deltas[0];
  assert.ok(launch.valid && launch.fields.supply?.after === "1000000000000", "launch sets supply");
  assert.ok(launch.balances.some((b) => b.account === CREATOR && BigInt(b.delta) > 0n), "creator share credited");

  const seed = deltas[1];
  assert.equal(seed.fields.poolXno?.after, "1000000000", "seed credits pool XNO");
  assert.equal(seed.fields.treasury?.before, "950000000000", "treasury drained to pool");

  const buy = deltas[2];
  assert.ok(buy.valid);
  assert.ok(BigInt(buy.fields.poolXno!.after) > BigInt(buy.fields.poolXno!.before), "buy raises pool XNO");
  assert.ok(buy.balances.some((b) => b.account === ALICE && BigInt(b.delta) > 0n), "buyer receives tokens");

  const rejected = deltas[3];
  assert.ok(!rejected.valid && /slippage|insufficient/i.test(rejected.reason ?? ""), "rejection reason captured");
  assert.equal(Object.keys(rejected.fields).length, 0, "rejected op changes nothing");

  // Deltas must exactly reconcile to final state (sum of deltas == state).
  const sumPool = deltas.filter((d) => d.valid).reduce((a, d) => (d.fields.poolXno ? BigInt(d.fields.poolXno.after) : a), 0n);
  assert.equal(sumPool, state.get(TOKEN)!.poolXno, "deltas reconcile with final state");
}

// ── A3: classifier ──────────────────────────────────────────────────────────
{
  const pool = addr("7");
  const poolByPub = new Map([[pool.pub.toLowerCase(), TOKEN]]);

  assert.equal(classifyLink(encodeOpLink(TOKEN, { kind: "buy", xno: 0n, minTokens: 0n })).kind, "compact-op");
  assert.equal(classifyLink(encodeOpLink(TOKEN, { kind: "buy", xno: 0n, minTokens: 0n })).opKind, "buy");
  assert.equal(classifyLink(commitLink(TOKEN, { kind: "transfer", to: addr("6").address, amount: 1n })).kind, "commit-op");
  const [fa] = encodeFragLinks(TOKEN, { kind: "sell", tokens: 1n, minXno: 1n });
  assert.deepEqual(classifyLink(fa), { kind: "fragment-a", opKind: "sell", tokenId: TOKEN.toLowerCase() });
  assert.equal(classifyLink(immutableAnchorLink(TOKEN)).kind, "meta-anchor-immutable");
  assert.equal(classifyLink(ANCHOR_PUB).kind, "hello");
  assert.equal(classifyLink(ANCHOR_PUB, { representative: poolHelloRepAddress(TOKEN) }).kind, "pool-hello");
  assert.deepEqual(classifyLink(pool.pub, { amount: "5000", poolByPub }), { kind: "pool-deposit", tokenId: TOKEN });
  assert.equal(classifyLink("9".repeat(64), { amount: "5000" }).kind, "send");
}

// ── H4: payout attribution ──────────────────────────────────────────────────
{
  const seller = addr("1");
  const refunder = addr("2");
  const sells: SellPayout[] = [
    { tokenId: TOKEN, to: seller.address, amountRaw: 100n, hash: "s1" },
    { tokenId: TOKEN, to: seller.address, amountRaw: 50n, hash: "s2" },
  ];
  const refunds = new Map([[refunder.address, 30n]]);
  const send = (link: string, amount: string, h: string, height: bigint): NanoBlock => ({
    account: "nano_pool", hash: h, previous: "0".repeat(64), link, representative: "r", height, amount, subtype: "send",
  });

  // One netted send covers BOTH sells; a second covers the refund.
  const blocks = [send(seller.pub, "150", "p1", 1n), send(refunder.pub, "30", "p2", 2n)];
  const cov = attributePoolSends(blocks, sells, refunds, (pub) =>
    nanocurrency.deriveAddress(pub, { useNanoPrefix: true })
  );
  assert.equal(cov.length, 2);
  assert.deepEqual(
    cov[0].covers.map((c) => [c.kind, c.hash, c.amountRaw]),
    [["sell", "s1", "100"], ["sell", "s2", "50"]],
    "one send attributed to both sells positionally"
  );
  assert.deepEqual(cov[1].covers, [{ kind: "refund", hash: undefined, amountRaw: "30" }]);

  // Partial payment attributes partially, in order.
  const partial = attributePoolSends([send(seller.pub, "120", "p3", 1n)], sells, new Map(), (pub) =>
    nanocurrency.deriveAddress(pub, { useNanoPrefix: true })
  );
  assert.deepEqual(
    partial[0].covers.map((c) => [c.hash, c.amountRaw]),
    [["s1", "100"], ["s2", "20"]],
    "partial send consumes queue in order"
  );
}

console.log("✅ explorer engine tests passed");
