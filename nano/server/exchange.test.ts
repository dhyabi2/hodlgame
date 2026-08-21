import { strict as assert } from "node:assert";
import { depositSeed, depositAddress } from "./exchange";

const MASTER = "a".repeat(64);

// 1. Deterministic: same (master, customer) → same account.
assert.equal(depositAddress(MASTER, "cust-1"), depositAddress(MASTER, "cust-1"), "deterministic per customer");

// 2. Distinct per customer and per master.
assert.notEqual(depositAddress(MASTER, "cust-1"), depositAddress(MASTER, "cust-2"), "distinct customers → distinct accounts");
assert.notEqual(depositAddress(MASTER, "cust-1"), depositAddress("b".repeat(64), "cust-1"), "distinct master → distinct");

// 3. Real nano_ address.
assert.match(depositAddress(MASTER, "cust-1"), /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/, "valid nano address");

// 4. Domain-separated + length-validated (no boundary ambiguity like the old
//    pool-seed hex concat): a bad master is rejected.
assert.throws(() => depositSeed("nothex", "c"), /64 hex/);
// customerId is length-prefixed by the NUL domain tag, so "a"+"bc" != "ab"+"c".
assert.notEqual(depositSeed(MASTER, "abc"), depositSeed(MASTER, "ab"), "customer boundary unambiguous");

console.log("✅ exchange deposit-derivation tests passed");
