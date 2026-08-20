import { strict as assert } from "node:assert";
import { canonicalOrder, type IndexedEvent } from "./multiIndexer";

function ev(height: bigint, hash: string): IndexedEvent {
  return { tokenId: "t", op: { kind: "claim" }, sender: "s", height, hash };
}

// Equal per-account heights (the common case — every account has a block at
// height 1, 2, …) must resolve to ONE canonical order across indexers,
// independent of the order the events were discovered/enumerated in.
{
  const a = ev(1n, "cccc");
  const b = ev(1n, "aaaa");
  const c = ev(1n, "bbbb");

  const order1 = [a, b, c].slice().sort(canonicalOrder).map((e) => e.hash);
  const order2 = [c, b, a].slice().sort(canonicalOrder).map((e) => e.hash);
  const order3 = [b, a, c].slice().sort(canonicalOrder).map((e) => e.hash);

  assert.deepEqual(order1, ["aaaa", "bbbb", "cccc"], "ties resolve by hash");
  assert.deepEqual(order1, order2, "input order cannot change the result");
  assert.deepEqual(order1, order3, "input order cannot change the result");
}

// Height still dominates the hash tie-break.
{
  const sorted = [ev(3n, "aaaa"), ev(1n, "zzzz"), ev(2n, "mmmm")]
    .sort(canonicalOrder)
    .map((e) => e.height);
  assert.deepEqual(sorted, [1n, 2n, 3n], "height ordered first");
}

console.log("✅ canonical event-ordering tests passed");
