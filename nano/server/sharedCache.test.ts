import { strict as assert } from "node:assert";
import { StoreBlockCache } from "./sharedCache";
import type { NanoBlock } from "../indexer/blockSource";

// In-memory store backend so we test the cache's guarantees, not the durable store.
function memStore() {
  const m = new Map<string, string>();
  return {
    load: async (k: string) => (m.has(k) ? m.get(k)! : null),
    save: async (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

const ACC = "nano_1abc";
const F1 = "A".repeat(64);
const F2 = "B".repeat(64);

async function monotonicFrontier() {
  const s = memStore();
  const c = new StoreBlockCache(s.load, s.save);

  await c.putFrontier(ACC, F1, 10);
  assert.deepEqual(await c.getFrontier(ACC), { frontier: F1, height: 10 });

  // A LAGGING view (lower height) must NOT roll the frontier back.
  await c.putFrontier(ACC, F2, 7);
  assert.deepEqual(await c.getFrontier(ACC), { frontier: F1, height: 10 }, "lower height must not overwrite");

  // Equal height is also a no-op (strictly-higher only).
  await c.putFrontier(ACC, F2, 10);
  assert.equal((await c.getFrontier(ACC))!.frontier, F1, "equal height must not overwrite");

  // A genuinely fresher view advances it.
  await c.putFrontier(ACC, F2, 11);
  assert.deepEqual(await c.getFrontier(ACC), { frontier: F2, height: 11 }, "higher height advances");

  // A second, cold instance sharing the same store reads the advanced value.
  const c2 = new StoreBlockCache(s.load, s.save);
  assert.deepEqual(await c2.getFrontier(ACC), { frontier: F2, height: 11 }, "shared across instances");
}

async function bigintRoundTrip() {
  const s = memStore();
  const c = new StoreBlockCache(s.load, s.save);
  const blocks: NanoBlock[] = [
    { account: ACC, hash: "1".repeat(64), previous: "0".repeat(64), link: "2".repeat(64), representative: ACC, height: 1n, amount: "1000000", balance: "1000000", subtype: "receive" },
    { account: ACC, hash: "3".repeat(64), previous: "1".repeat(64), link: "4".repeat(64), representative: ACC, height: 999999999999999n, amount: "5", balance: "999995" },
  ];
  await c.putBlocks(ACC, F1, blocks);
  const got = await c.getBlocks(ACC, F1);
  assert.ok(got, "blocks returned");
  assert.equal(got!.length, 2);
  assert.equal(typeof got![0].height, "bigint", "height survives as bigint");
  assert.equal(got![1].height, 999999999999999n, "large bigint height exact");
  assert.equal(got![0].balance, "1000000", "decimal string field untouched");
  assert.deepEqual(got, blocks, "full byte-identical round-trip");

  // Miss on a different frontier key.
  assert.equal(await c.getBlocks(ACC, F2), null, "unknown frontier misses");
}

async function corruptStoreIsSafe() {
  const s = memStore();
  s.map.set("frontier:" + ACC, "{not json");
  s.map.set("chain:" + ACC + ":" + F1, "garbage");
  const c = new StoreBlockCache(s.load, s.save);
  assert.equal(await c.getFrontier(ACC), null, "corrupt frontier → null, no throw");
  assert.equal(await c.getBlocks(ACC, F1), null, "corrupt chain → null, no throw");
}

async function main() {
  await monotonicFrontier();
  await bigintRoundTrip();
  await corruptStoreIsSafe();
  console.log("✅ sharedCache: monotonic frontier + bigint round-trip + corruption-safe");
}
main().catch((e) => { console.error(e); process.exit(1); });
