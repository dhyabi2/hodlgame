import { strict as assert } from "node:assert";
import { multiEmpty, applyBlock, applyBlocks, tokens, tokenState } from "./multi";
import { tokenIdFromLaunchHash } from "./token";

const CREATOR_A = "nano_creator_a";
const CREATOR_B = "nano_creator_b";
const ALICE = "nano_alice";
const TOKEN_A = tokenIdFromLaunchHash("a".repeat(64));
const TOKEN_B = tokenIdFromLaunchHash("b".repeat(64));

function launchOp(supply: bigint) {
  return { kind: "launch" as const, supply, name: "T", symbol: "T", decimals: 6, image: "" };
}

// 1. tokenId derivation: 32-hex, lower-cased, first-16-bytes.
{
  assert.equal(TOKEN_A.length, 32, "token id is 128 bits");
  assert.equal(tokenIdFromLaunchHash("ABCDEF" + "0".repeat(58)), "abcdef" + "0".repeat(26), "lower-cased");
}

// 2. Two launches create two isolated tokens, each with its own 5% creator share.
{
  const m = applyBlocks(multiEmpty(), [
    { tokenId: TOKEN_A, op: launchOp(1_000_000_000_000n), sender: CREATOR_A, height: 1n },
    { tokenId: TOKEN_B, op: launchOp(2_000_000_000_000n), sender: CREATOR_B, height: 2n },
  ]);
  const all = tokens(m);
  assert.equal(all.length, 2, "two tokens launched");
  const a = tokenState(m, TOKEN_A);
  const b = tokenState(m, TOKEN_B);
  assert.equal(a.creator, CREATOR_A);
  assert.equal(b.creator, CREATOR_B);
  assert.equal(a.creatorShare, (1_000_000_000_000n * 500n) / 10_000n);
  assert.equal(b.creatorShare, (2_000_000_000_000n * 500n) / 10_000n);
  assert.notEqual(a.supply, b.supply, "independent supplies");
}

// 3. Isolation: a buy on token A must not touch token B's pool or balances.
{
  let m = multiEmpty();
  m = applyBlock(m, { tokenId: TOKEN_A, op: launchOp(1_000_000_000_000n), sender: CREATOR_A, height: 1n });
  m = applyBlock(m, { tokenId: TOKEN_B, op: launchOp(1_000_000_000_000n), sender: CREATOR_B, height: 2n });
  m = applyBlock(m, { tokenId: TOKEN_A, op: { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n }, sender: CREATOR_A, height: 3n });
  const bBefore = tokenState(m, TOKEN_B);

  m = applyBlock(m, { tokenId: TOKEN_A, op: { kind: "buy", xno: 100_000_000n, minTokens: 0n }, sender: ALICE, height: 4n });

  const a = tokenState(m, TOKEN_A);
  const b = tokenState(m, TOKEN_B);
  assert.ok((a.balances.get(ALICE) ?? 0n) > 0n, "A buyer got tokens");
  assert.equal(a.poolXno, 1_100_000_000n, "A pool XNO grew by the buy");
  assert.equal(b.poolXno, bBefore.poolXno, "B pool untouched");
  assert.equal(b.balances.get(ALICE) ?? 0n, 0n, "B has no ALICE balance");
  assert.equal(b.creator, CREATOR_B);
}

// 4. Deterministic: folding the same multi-block list twice is identical.
{
  const blocks = [
    { tokenId: TOKEN_A, op: launchOp(1_000_000_000_000n), sender: CREATOR_A, height: 1n },
    { tokenId: TOKEN_A, op: { kind: "seedLiq" as const, xno: 1_000_000_000n, tokens: 950_000_000_000n }, sender: CREATOR_A, height: 2n },
    { tokenId: TOKEN_A, op: { kind: "buy" as const, xno: 100_000_000n, minTokens: 0n }, sender: ALICE, height: 3n },
    { tokenId: TOKEN_B, op: launchOp(500_000_000_000n), sender: CREATOR_B, height: 4n },
  ];
  const a = applyBlocks(multiEmpty(), blocks);
  const b = applyBlocks(multiEmpty(), blocks);
  assert.deepEqual(a, b, "multi replays are byte-identical");
}

console.log("✅ multi-token state router tests passed");
