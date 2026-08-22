// Direct-Settlement indexer tests: launchV2 decode, frag-declared virtual
// seeds and self-earmark buys (balanceAt from the SIGNED block balance),
// queue-routed deposit binding to a seller's address, and signed-balance
// observations voiding defected collateral — all through the real
// MultiIndexer pipeline over a MemorySource.

import { strict as assert } from "node:assert";
import { MemorySource, type NanoBlock } from "./blockSource";
import { MultiIndexer } from "./multiIndexer";
import { encodeOpLink } from "../core/oplink";
import { encodeFragLinks } from "../core/fraglink";
import { tokenIdFromLaunchHash } from "../core/token";
import * as nanocurrency from "nanocurrency";

function keys(seedChar: string) {
  const sk = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  const pub = nanocurrency.derivePublicKey(sk);
  return { pub, address: nanocurrency.deriveAddress(pub, { useNanoPrefix: true }) };
}
const CR = keys("1");
const ALICE = keys("2");
const BOB = keys("3");
const DAVE = keys("4");

let n = 0;
const mkHash = () => (++n).toString(16).padStart(64, "0");

function blk(
  account: string,
  link: string,
  height: bigint,
  opts?: { previous?: string; amount?: string; balance?: string; subtype?: string }
): NanoBlock {
  return {
    account,
    hash: mkHash(),
    previous: opts?.previous ?? "0".repeat(64),
    link,
    representative: account,
    height,
    amount: opts?.amount ?? "1",
    balance: opts?.balance,
    subtype: opts?.subtype,
  };
}

async function main() {
  const source = new MemorySource();

  // creator chain: launchV2 + frag seedLiq (virtual 100M XNO / 1B tokens)
  const launch = blk(CR.address, encodeOpLink("", { kind: "launch", supply: 1_000_000_000_000n, name: "", symbol: "", decimals: 6, image: "", direct: true }), 1n, { balance: "1000" });
  const T = tokenIdFromLaunchHash(launch.hash);
  const [seedA, seedB] = encodeFragLinks(T, { kind: "seedLiq", xno: 100_000_000n, tokens: 1_000_000_000n });
  const sA = blk(CR.address, seedA, 2n, { previous: launch.hash, balance: "999" });
  const sB = blk(CR.address, seedB, 3n, { previous: sA.hash, balance: "998" });
  source.push(launch); source.push(sA); source.push(sB);

  // Alice: frag self-earmark buy of 100M, signed balance 200M on the completing block
  const [bA, bB] = encodeFragLinks(T, { kind: "buy", xno: 100_000_000n, minTokens: 0n });
  const aA = blk(ALICE.address, bA, 10n, { balance: "200000001" });
  const aB = blk(ALICE.address, bB, 11n, { previous: aA.hash, balance: "200000000" });
  source.push(aA); source.push(aB);

  // Bob: frag self-earmark buy of 100M, signed balance 150M
  const [cA, cB] = encodeFragLinks(T, { kind: "buy", xno: 100_000_000n, minTokens: 0n });
  const dA = blk(BOB.address, cA, 15n, { balance: "150000001" });
  const dB = blk(BOB.address, cB, 16n, { previous: dA.hash, balance: "150000000" });
  source.push(dA); source.push(dB);

  {
    const idx = new MultiIndexer(source);
    await idx.sync([CR.address, ALICE.address, BOB.address]);
    const s = idx.getState().get(T)!;
    assert.equal(s.direct, true);
    assert.equal(s.poolXno, 300_000_000n); // 100 virtual + two 100M buys
    assert.equal(s.earmark.get(ALICE.address), 100_000_000n);
    assert.equal(s.earmark.get(BOB.address), 100_000_000n);
    assert(s.balances.get(ALICE.address)! > 0n);
    console.log("1 ok: launchV2 + virtual frag seed + frag self-earmark buys index");
  }

  // Alice exits with appreciation: frag sell of everything, honest balance
  const preIdx = new MultiIndexer(source);
  await preIdx.sync([CR.address, ALICE.address, BOB.address]);
  const aTok = preIdx.getState().get(T)!.balances.get(ALICE.address)!;
  const [eA, eB] = encodeFragLinks(T, { kind: "sell", tokens: aTok, minXno: 0n });
  const fA = blk(ALICE.address, eA, 20n, { previous: aB.hash, balance: "199999999" });
  const fB = blk(ALICE.address, eB, 21n, { previous: fA.hash, balance: "199999998" });
  source.push(fA); source.push(fB);

  let owed: bigint;
  {
    const idx = new MultiIndexer(source);
    await idx.sync([CR.address, ALICE.address, BOB.address]);
    const s = idx.getState().get(T)!;
    assert.equal(s.earmark.get(ALICE.address) ?? 0n, 0n, "cost basis fully self-netted");
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].account, ALICE.address);
    owed = s.queue[0].owed;
    assert(owed > 0n, "appreciation queued");
    console.log("2 ok: frag sell self-nets cost, queues appreciation:", owed.toString());
  }

  // Dave pays Alice DIRECTLY (deposit send to her address) + compact buy op
  const dep = blk(DAVE.address, ALICE.pub, 30n, { amount: owed.toString(), balance: "900000000", subtype: "send" });
  const opD = blk(DAVE.address, encodeOpLink(T, { kind: "buy", xno: 0n, minTokens: 0n }), 31n, { previous: dep.hash, balance: "899999999" });
  source.push(dep); source.push(opD);

  {
    const idx = new MultiIndexer(source);
    await idx.sync([CR.address, ALICE.address, BOB.address, DAVE.address]);
    const s = idx.getState().get(T)!;
    assert.equal(s.queue.length, 0, "queue paid off wallet-to-wallet");
    assert(s.balances.get(DAVE.address)! > 0n, "buyer minted through the curve");
    assert.equal(s.earmark.get(DAVE.address) ?? 0n, 0n, "routed buy creates no earmark");
    console.log("3 ok: queue-routed buy binds to the seller's address and settles the claim");
  }

  // Bob defects: a plain send strips his balance to 40M (< his floor)
  const strip = blk(BOB.address, "ee".repeat(32), 17n, { previous: dB.hash, amount: "110000000", balance: "40000000", subtype: "send" });
  source.push(strip);

  {
    const idx = new MultiIndexer(source);
    await idx.sync([CR.address, ALICE.address, BOB.address, DAVE.address]);
    const s = idx.getState().get(T)!;
    const floor = s.earmarkFloor.get(BOB.address) ?? 0n;
    assert(floor <= 40_000_000n, "floor reduced to the observed balance");
    assert(s.earmark.get(BOB.address)! < 100_000_000n, "earmark voided proportionally");
    console.log("4 ok: signed-balance observation voids the defector's collateral");
  }

  // ── 5. fixpoint STABILITY: appending later events never re-prices history ──
  // A fresh wallet's buy (height 4) sorts before an old wallet's launch
  // (height 30); the fixpoint defers it and anchors it at its earliest valid
  // point (right after the seed). A later buy (height 35) arriving must not
  // change what the deferred buy received.
  {
    const { fixpointOrder } = await import("./replay");
    const T5 = "55".repeat(16);
    const base = [
      { tokenId: T5, op: { kind: "buy", xno: 20_000_000n, minTokens: 0n, balanceAt: 100_000_000n } as const, sender: ALICE.address, height: 4n },
      { tokenId: T5, op: { kind: "launch", supply: 1_000_000_000_000n, name: "", symbol: "", decimals: 6, image: "", direct: true } as const, sender: CR.address, height: 30n },
      { tokenId: T5, op: { kind: "seedLiq", xno: 100_000_000n, tokens: 1_000_000_000n } as const, sender: CR.address, height: 32n },
    ];
    const later = { tokenId: T5, op: { kind: "buy", xno: 40_000_000n, minTokens: 0n, balanceAt: 900_000_000n } as const, sender: BOB.address, height: 35n };
    const without = fixpointOrder(base as any).state.get(T5)!.balances.get(ALICE.address)!;
    const withLater = fixpointOrder([...base, later] as any).state.get(T5)!.balances.get(ALICE.address)!;
    assert.equal(without, withLater, "Alice's deferred buy must be anchored — a later block can't re-price it");
    console.log("5 ok: fixpoint anchors deferred ops — appending events never rewrites history");
  }

  // ── 6. REGRESSION (deferred-buy defection): a self-earmark buy sorted BEFORE
  //    its token's seed is deferred, then a strip drops the buyer's balance
  //    below the floor the deferred buy establishes. A per-block observation
  //    taken before the floor existed is a no-op; the HEAD observation (folded
  //    after every event) must still catch the shortfall and void the position.
  {
    const src2 = new MemorySource();
    // creator launches + seeds at HIGHER lamport than the attacker's shallow,
    // externally-funded chain, so the attacker's buy sorts before the seed.
    const l2 = blk(CR.address, encodeOpLink("", { kind: "launch", supply: 1_000_000_000_000n, name: "", symbol: "", decimals: 6, image: "", direct: true }), 1n, { balance: "1000" });
    const T6 = tokenIdFromLaunchHash(l2.hash);
    const [s2a, s2b] = encodeFragLinks(T6, { kind: "seedLiq", xno: 100_000_000n, tokens: 1_000_000_000n });
    const sa = blk(CR.address, s2a, 2n, { previous: l2.hash, balance: "999" });
    const sb = blk(CR.address, s2b, 3n, { previous: sa.hash, balance: "998" });
    // attacker X: open (funded 200M externally) -> frag buy 100M -> strip to 40M
    const xOpen = blk(BOB.address, "cc".repeat(32), 1n, { balance: "200000000", subtype: "receive", amount: "200000000" });
    const [xb1, xb2] = encodeFragLinks(T6, { kind: "buy", xno: 100_000_000n, minTokens: 0n });
    const xa = blk(BOB.address, xb1, 2n, { previous: xOpen.hash, balance: "200000000" });
    const xbk = blk(BOB.address, xb2, 3n, { previous: xa.hash, balance: "200000000" });
    const xStrip = blk(BOB.address, "dd".repeat(32), 4n, { previous: xbk.hash, amount: "160000000", balance: "40000000", subtype: "send" });
    for (const b of [l2, sa, sb, xOpen, xa, xbk, xStrip]) src2.push(b);

    const idx = new MultiIndexer(src2);
    await idx.sync([CR.address, BOB.address]);
    const s = idx.getState().get(T6)!;
    const floor = s.earmarkFloor.get(BOB.address) ?? 0n;
    assert(floor <= 40_000_000n, `deferred-buy floor must be re-checked against head balance (got ${floor})`);
    console.log("6 ok: head observation voids a deferred-buy defection (floor=" + floor + ")");
  }

  console.log("✅ direct-settlement indexer tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
