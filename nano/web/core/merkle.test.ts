import { strict as assert } from "node:assert";
import { buildMerkle, merkleProof, verifyMerkleProof, balanceLeaf, balanceLeaves, balanceRoot, proveBalance } from "./merkle";
import { emptyState } from "./state";
import type { MultiState } from "./multi";

// 1. Every leaf in a tree proves and verifies; wrong root / tampered leaf fail.
{
  const leaves = ["a", "b", "c", "d", "e"].map((x) => balanceLeaf("ab".repeat(16), "nano_" + x, "100")).sort();
  const { root } = buildMerkle(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const p = merkleProof(leaves, i);
    assert.equal(p.root, root, "proof carries the tree root");
    assert.ok(verifyMerkleProof(p), `leaf ${i} verifies`);
    // Tampered leaf → fails.
    assert.ok(!verifyMerkleProof({ ...p, leaf: p.leaf + "x" }), "tampered leaf rejected");
    // Wrong root → fails.
    assert.ok(!verifyMerkleProof({ ...p, root: "f".repeat(64) }), "wrong root rejected");
    // Tampered sibling → fails.
    if (p.siblings.length) {
      const bad = { ...p, siblings: [...p.siblings] };
      bad.siblings[0] = "0".repeat(64);
      assert.ok(!verifyMerkleProof(bad), "tampered sibling rejected");
    }
  }
}

// 2. Single-leaf and odd-count trees work (odd node promoted).
{
  const one = ["x"].map((x) => balanceLeaf("cd".repeat(16), x, "1"));
  assert.ok(verifyMerkleProof(merkleProof(one, 0)), "single leaf verifies");
  const three = ["x", "y", "z"].map((x) => balanceLeaf("cd".repeat(16), x, "1")).sort();
  for (let i = 0; i < 3; i++) assert.ok(verifyMerkleProof(merkleProof(three, i)), `odd-tree leaf ${i}`);
}

// 3. Over a real MultiState: only non-zero holdings are leaves; proof round-trips.
{
  const s = emptyState();
  s.balances.set("nano_alice", 60n);
  s.balances.set("nano_bob", 40n);
  s.balances.set("nano_zero", 0n); // excluded
  const TOKEN = "ab".repeat(16);
  const state: MultiState = new Map([[TOKEN, s]]);

  const leaves = balanceLeaves(state);
  assert.equal(leaves.length, 2, "zero balances excluded");
  const root = balanceRoot(state);

  const proof = proveBalance(state, TOKEN, "nano_alice");
  assert.ok(proof, "alice has a proof");
  assert.equal(proof!.root, root, "proof root == balance root");
  assert.ok(verifyMerkleProof(proof!), "alice balance proof verifies against the root");
  assert.match(proof!.leaf, /\|nano_alice\|60$/, "leaf carries the exact balance");

  assert.equal(proveBalance(state, TOKEN, "nano_zero"), null, "no proof for a zero balance");
  assert.equal(proveBalance(state, TOKEN, "nano_nobody"), null, "no proof for a non-holder");

  // Determinism: rebuild from a differently-ordered state → same root.
  const s2 = emptyState();
  s2.balances.set("nano_bob", 40n);
  s2.balances.set("nano_alice", 60n);
  assert.equal(balanceRoot(new Map([[TOKEN, s2]])), root, "balance root is order-independent");
}

console.log("✅ merkle balance-proof tests passed");
