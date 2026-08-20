import { strict as assert } from "node:assert";
import { replay } from "./replay";
import { MemorySource, type NanoBlock } from "./blockSource";
import { Indexer, mapResolver } from "./indexer";
import { opCommitment } from "../core/encoding";
import type { Op } from "../core/ops";

const CREATOR = "nano_creator";
const ALICE = "nano_alice";
const BOB = "nano_bob";

async function main() {
  // 1. Replay flags invalid ops without throwing, and keeps prior state.
  {
    const events = [
      { sender: CREATOR, op: { kind: "launch" as const, supply: 1_000_000_000_000n, name: "T", symbol: "T", decimals: 6, image: "" }, height: 1n },
      { sender: ALICE, op: { kind: "transfer" as const, to: BOB, amount: 99_999_999_999n }, height: 2n }, // ALICE has 0 → invalid
      { sender: CREATOR, op: { kind: "transfer" as const, to: ALICE, amount: 1_000_000n }, height: 3n },
    ];
    const { state, invalid } = replay(events);
    assert.equal(invalid.length, 1, "one invalid op flagged");
    assert.match(invalid[0].reason, /insufficient/, "reason recorded");
    assert.equal(state.balances.get(ALICE), 1_000_000n, "valid op after the bad one applied");
  }

  // 2. Indexer sync: blocks → resolve ops via commitment map → state.
  {
    const launchOp: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "HoldFun", symbol: "HOLD", decimals: 6, image: "" };
    const seedOp: Op = { kind: "seedLiq", xno: 10n ** 30n, tokens: 950_000_000_000n };
    const buyOp: Op = { kind: "buy", xno: 10n ** 30n, minTokens: 0n };

    const map = new Map<string, Op>([
      [opCommitment(launchOp), launchOp],
      [opCommitment(seedOp), seedOp],
      [opCommitment(buyOp), buyOp],
    ]);

    const source = new MemorySource();
    const mkBlock = (account: string, op: Op, height: bigint, previous = "0".repeat(64)): NanoBlock => ({
      account,
      hash: "0".repeat(64),
      previous,
      link: opCommitment(op),
      representative: "nano_token",
      height,
    });
    source.push(mkBlock(CREATOR, launchOp, 1n));
    source.push(mkBlock(CREATOR, seedOp, 2n));
    source.push(mkBlock(ALICE, buyOp, 3n));

    const indexer = new Indexer(source, mapResolver(map));
    const { applied, invalid } = await indexer.sync([CREATOR, ALICE]);
    assert.equal(invalid, 0, "no invalid");
    assert.equal(applied, 3, "launch + seedLiq + buy applied");
    const s = indexer.getState();
    assert.equal(s.launched, true);
    assert.equal(s.creator, CREATOR);
    assert.ok((s.balances.get(ALICE) ?? 0n) > 0n, "buyer got tokens");
  }

  console.log("✅ replay + indexer tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
