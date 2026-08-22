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

  console.log("✅ direct-settlement indexer tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
