import { strict as assert } from "node:assert";
import { canonicalize, stateRoot } from "./canonical";
import { emptyState } from "./state";
import type { MultiState } from "./multi";

// 1. Canonicalization: sorted keys, bigint-as-string, Map ordering, undefined dropped.
{
  assert.equal(canonicalize({ b: 1, a: 2n }), '{"a":"2","b":1}');
  assert.equal(
    canonicalize(new Map([["z", 1], ["a", 2]])),
    '{"a":2,"z":1}',
    "map entries sorted by key"
  );
  assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}', "undefined dropped");
  assert.equal(canonicalize([1n, "x"]), '["1","x"]');
}

// 2. Root is deterministic and independent of Map insertion order.
{
  const s1 = emptyState();
  s1.launched = true;
  s1.supply = 100n;
  s1.balances.set("nano_a", 60n);
  s1.balances.set("nano_b", 40n);

  const s2 = emptyState();
  s2.launched = true;
  s2.supply = 100n;
  s2.balances.set("nano_b", 40n); // reversed insertion order
  s2.balances.set("nano_a", 60n);

  const m1: MultiState = new Map([["t1", s1]]);
  const m2: MultiState = new Map([["t1", s2]]);
  assert.equal(stateRoot(m1), stateRoot(m2), "insertion order never changes the root");
  assert.match(stateRoot(m1), /^[0-9a-f]{64}$/, "root is 64-hex");
}

// 3. Root covers consensus fields only: off-chain meta differences don't split verifiers.
{
  const a = emptyState();
  a.supply = 5n;
  a.name = "Doge";
  a.image = "ipfs://cid1";
  const b = emptyState();
  b.supply = 5n;
  b.name = "Different Mirror Name";
  b.image = "";
  assert.equal(
    stateRoot(new Map([["t", a]])),
    stateRoot(new Map([["t", b]])),
    "metadata is non-consensus"
  );

  const c = emptyState();
  c.supply = 6n;
  assert.notEqual(stateRoot(new Map([["t", a]])), stateRoot(new Map([["t", c]])), "consensus change moves the root");
}

console.log("✅ canonical state-root tests passed");
