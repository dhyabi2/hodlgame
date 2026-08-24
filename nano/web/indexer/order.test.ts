import { strict as assert } from "node:assert";
import { canonicalOrder, TIME_ORDER_ERA, type IndexedEvent } from "./multiIndexer";

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

// Within the time-order era, network time dominates lamport/height: a fresh
// externally-funded wallet (near-zero lamport clocks, low heights) trading
// LATER in real time must sort AFTER older trades — lamport-primary ordering
// let it insert before them and retroactively re-price history (the reported
// live position wipe).
const ERA = TIME_ORDER_ERA;
{
  const oldBuy: IndexedEvent = { ...ev(10n, "cccc"), timestamp: ERA + 1000, lam: 10n };
  const freshLater: IndexedEvent = { ...ev(4n, "aaaa"), timestamp: ERA + 2000, lam: 4n };
  const sorted = [freshLater, oldBuy].sort(canonicalOrder).map((e) => e.hash);
  assert.deepEqual(sorted, ["cccc", "aaaa"], "network time dominates lamport in the new era");
}

// Same-second ties fall back to lamport causality, then height, then hash.
{
  const a: IndexedEvent = { ...ev(1n, "zzzz"), timestamp: ERA + 1000, lam: 2n };
  const b: IndexedEvent = { ...ev(9n, "aaaa"), timestamp: ERA + 1000, lam: 5n };
  assert.deepEqual([b, a].sort(canonicalOrder).map((e) => e.hash), ["zzzz", "aaaa"], "same-second ties break by lamport");
}

// A block's op (sub 0) folds before its own balance observation (sub 1),
// which shares the block's timestamp — the floor check must see the op.
{
  const op: IndexedEvent = { ...ev(3n, "abcd"), timestamp: ERA + 1000 };
  const obs: IndexedEvent = { ...ev(3n, "abcd"), timestamp: ERA + 1000, sub: 1 };
  assert.deepEqual([obs, op].sort(canonicalOrder).map((e) => e.sub ?? 0), [0, 1], "op before its own balance observation");
}

// Pre-era history is FROZEN under the legacy keys: timestamps below the era
// boundary are ignored (lamport/height/hash only), so already-served state
// replays bit-exact, and every pre-era event sorts before every new-era one.
{
  const legacyLate: IndexedEvent = { ...ev(10n, "cccc"), timestamp: ERA - 100, lam: 10n };
  const legacyEarly: IndexedEvent = { ...ev(4n, "aaaa"), timestamp: ERA - 50, lam: 4n };
  const sorted = [legacyLate, legacyEarly].sort(canonicalOrder).map((e) => e.hash);
  assert.deepEqual(sorted, ["aaaa", "cccc"], "pre-era events keep legacy lamport order");

  const newEra: IndexedEvent = { ...ev(2n, "bbbb"), timestamp: ERA, lam: 2n };
  assert.deepEqual([newEra, legacyLate].sort(canonicalOrder).map((e) => e.hash), ["cccc", "bbbb"], "pre-era sorts before new era");
}

// Events without timestamps (unit fixtures, hypothetical untimestamped
// blocks) keep the pure causal order — timestamp 0 on both sides is a tie.
{
  const sorted = [ev(2n, "bbbb"), ev(1n, "aaaa")].sort(canonicalOrder).map((e) => e.height);
  assert.deepEqual(sorted, [1n, 2n], "no timestamps → causal order unchanged");
}

// PROPERTY (grandfather guarantee): on any event set whose timestamps are all
// below TIME_ORDER_ERA — i.e. every block that existed before the era cut —
// the new comparator is EXACTLY the legacy (lamport, height, hash, sub)
// comparator, so already-served state replays bit-identical. Seeded-random
// sweep so the check is reproducible.
{
  const legacy = (a: IndexedEvent, b: IndexedEvent): number => {
    const la = a.lam ?? 0n, lb = b.lam ?? 0n;
    if (la !== lb) return la < lb ? -1 : 1;
    if (a.height !== b.height) return a.height < b.height ? -1 : 1;
    if (a.hash === b.hash) return (a.sub ?? 0) - (b.sub ?? 0);
    return a.hash < b.hash ? -1 : 1;
  };
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const hex = "0123456789abcdef";
  for (let round = 0; round < 50; round++) {
    const evs: IndexedEvent[] = Array.from({ length: 40 }, () => ({
      ...ev(BigInt(Math.floor(rnd() * 20)), Array.from({ length: 8 }, () => hex[Math.floor(rnd() * 16)]).join("")),
      timestamp: rnd() < 0.2 ? undefined : Math.floor(rnd() * (TIME_ORDER_ERA - 1)),
      lam: BigInt(Math.floor(rnd() * 30)),
      sub: rnd() < 0.3 ? 1 : 0,
    }));
    const a = [...evs].sort(canonicalOrder).map((e) => `${e.hash}:${e.sub ?? 0}`);
    const b = [...evs].sort(legacy).map((e) => `${e.hash}:${e.sub ?? 0}`);
    assert.deepEqual(a, b, `pre-era ordering must equal legacy ordering (round ${round})`);
  }
}

// Head observations stay LAST across the era boundary: a head stamped
// maxT+1 (>= era cut) sorts after every pre-era event even though its
// account's lam is small.
{
  const preEra: IndexedEvent = { ...ev(50n, "cccc"), timestamp: TIME_ORDER_ERA - 1, lam: 50n };
  const head: IndexedEvent = { ...ev(3n, "aaaa"), timestamp: TIME_ORDER_ERA, lam: 3n, sub: 2 };
  assert.deepEqual([head, preEra].sort(canonicalOrder).map((e) => e.hash), ["cccc", "aaaa"], "boundary head observation sorts last");
}

console.log("✅ canonical event-ordering tests passed");
