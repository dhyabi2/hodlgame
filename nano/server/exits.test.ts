import { strict as assert } from "node:assert";
import { applyOp, emptyState, claimableReward, FULL_REBATE_ERA } from "../core/state";
import { emptyExitLedger, preExit, recordExit, exitView } from "./exits";

// Two stakers + one leaver. The event's per-recipient shares must equal what
// the ledger itself credits (claimableReward), to the raw unit.
let s = emptyState();
const T = Number(FULL_REBATE_ERA) + 10;
s = applyOp(s, { kind: "launch", supply: 100_000_000n, name: "A", symbol: "A", decimals: 0, image: "" } as any, "creator", 1n, T);
for (const [a, n] of [["alice", 300_000n], ["bob", 100_000n], ["carol", 500_000n]] as const) {
  s = applyOp(s, { kind: "transfer", to: a, amount: n } as any, "creator", 2n, T);
  s = applyOp(s, { kind: "stake", amount: n } as any, a, 3n, T);
}
const led = emptyExitLedger();
const pre = preExit(s);
s = applyOp(s, { kind: "unstake", amount: 500_000n } as any, "carol", 4n, T + 1);
const e = recordExit(led, pre, s, { tokenId: "t", hash: "h4", sender: "carol", amount: 500_000n, time: T + 1 });

assert.equal(e.taxRaw, "100000", "20% tax");
assert.equal(e.burnRaw, "0", "full-rebate era: nothing burned");
assert.equal(e.rebateRaw, "100000");
assert.equal(e.recipients.length, 2, "carol does not pay herself");
assert.equal(e.recipients[0].account, "alice", "largest first");
for (const r of e.recipients) {
  assert.equal(r.gotRaw, claimableReward(s, r.account).toString(), `ledger-exact share for ${r.account}`);
}
assert.equal(e.recipients[0].yieldBps, 2500, "alice: 75k on 300k stake = 25%");
assert.equal(led.earned.get("bob"), 25_000n);
assert.equal(led.paidRaw, 100_000n);

// Partial unstake: the leaver's REMAINING stake still earns from their own exit,
// exactly as the ledger does (stake reduced before the rebate is distributed).
const pre2 = preExit(s);
const before = claimableReward(s, "alice");
s = applyOp(s, { kind: "unstake", amount: 100_000n } as any, "alice", 5n, T + 2);
const e2 = recordExit(led, pre2, s, { tokenId: "t", hash: "h5", sender: "alice", amount: 100_000n, time: T + 2 });
const aliceGot = e2.recipients.find((r) => r.account === "alice")!;
assert.ok(aliceGot, "alice's remaining 200k shares her own exit tax");
assert.equal(BigInt(aliceGot.gotRaw), claimableReward(s, "alice") - before, "alice's self-share is ledger-exact");
assert.equal(led.earned.get("alice"), 75_000n + BigInt(aliceGot.gotRaw));

// Viewer slice.
const v = exitView(e, "bob");
assert.equal(v.paidCount, 2);
assert.equal(v.mine?.gotRaw, "25000");
assert.equal(exitView(e).mine, null);

// Last staker leaving: tax burned, no recipients.
let z = emptyState();
z = applyOp(z, { kind: "launch", supply: 100_000n, name: "Z", symbol: "Z", decimals: 0, image: "" } as any, "c", 1n, T);
z = applyOp(z, { kind: "stake", amount: 500n } as any, "c", 2n, T);
const pz = preExit(z);
z = applyOp(z, { kind: "unstake", amount: 500n } as any, "c", 3n, T);
const ez = recordExit(emptyExitLedger(), pz, z, { tokenId: "z", hash: "hz", sender: "c", amount: 500n, time: T });
assert.equal(ez.burnRaw, "100");
assert.equal(ez.recipients.length, 0);

console.log("exits.test: ok");
