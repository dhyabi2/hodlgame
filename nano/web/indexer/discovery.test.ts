import { strict as assert } from "node:assert";
import { discoverAccounts } from "./discovery";
import type { CounterpartyReader, HelloInfo } from "./blockSource";
import { poolHelloRepPub, poolHelloRepAddress, tokenIdFromHelloRep, ANCHOR_ADDRESS } from "../core/anchor";

const TOKEN = "ab".repeat(16);

// 1. Rep encoding round-trips, via pub hex and address form.
{
  assert.equal(tokenIdFromHelloRep(poolHelloRepPub(TOKEN)), TOKEN.toLowerCase(), "pub form round-trips");
  assert.equal(tokenIdFromHelloRep(poolHelloRepAddress(TOKEN)), TOKEN.toLowerCase(), "address form round-trips");
  assert.equal(tokenIdFromHelloRep("9".repeat(64)), null, "ordinary rep is not a pool hello");
  assert.equal(tokenIdFromHelloRep("0".repeat(64)), null, "all-zero rep rejected");
  assert.equal(tokenIdFromHelloRep("not-an-address"), null, "garbage rejected");
}

async function main() {
// 2. Two-hop discovery: anchor hellos partition into users/pools; pool
//    counterparties (legacy buyers) join the user set; anchor + pools excluded.
{
  const POOL = "nano_pool_a";
  const graph: Record<string, { inbound: HelloInfo[]; outbound: string[] }> = {
    [ANCHOR_ADDRESS]: {
      inbound: [
        { sender: "nano_alice", representative: "9".repeat(64) }, // user hello
        { sender: POOL, representative: poolHelloRepPub(TOKEN) }, // pool hello
      ],
      outbound: ["nano_legacy"], // anchor bootstrap send
    },
    [POOL]: {
      inbound: [{ sender: "nano_buyer", representative: "1".repeat(64) }], // legacy buyer deposit
      outbound: ["nano_seller"], // payout recipient
    },
  };
  const reader: CounterpartyReader = {
    counterparties: async (a) => graph[a] ?? { inbound: [], outbound: [] },
  };

  const got = await discoverAccounts(reader, ANCHOR_ADDRESS);
  assert.deepEqual(got.users, ["nano_alice", "nano_buyer", "nano_legacy", "nano_seller"].sort(), "all participants found");
  assert.equal(got.pools.get(POOL), TOKEN.toLowerCase(), "pool→token binding recovered");
  assert.ok(!got.users.includes(ANCHOR_ADDRESS) && !got.users.includes(POOL), "anchor and pools excluded");
}

// 3. Determinism: shuffled reader responses converge to the same sorted set.
{
  const mk = (rev: boolean): CounterpartyReader => ({
    counterparties: async (a) => {
      if (a !== ANCHOR_ADDRESS) return { inbound: [], outbound: [] };
      const inbound = [
        { sender: "nano_x", representative: "9".repeat(64) },
        { sender: "nano_y", representative: "9".repeat(64) },
      ];
      return { inbound: rev ? inbound.reverse() : inbound, outbound: [] };
    },
  });
  const a = await discoverAccounts(mk(false), ANCHOR_ADDRESS);
  const b = await discoverAccounts(mk(true), ANCHOR_ADDRESS);
  assert.deepEqual(a.users, b.users, "order-independent");
}

console.log("✅ anchor discovery tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
