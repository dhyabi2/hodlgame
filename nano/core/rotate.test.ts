import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { applyRotations, isRotateRep, rotateMarkerAddress, ROTATE_MARKER_PUB, type RotationBlock } from "./rotate";

const P0 = "a".repeat(64);
const P1 = "b".repeat(64);
const P2 = "c".repeat(64);
const TOKEN = "ab".repeat(16);

// 1. Marker recognition (address + hex forms); ordinary reps rejected.
{
  assert.ok(isRotateRep(ROTATE_MARKER_PUB), "hex marker recognized");
  assert.ok(isRotateRep(rotateMarkerAddress()), "address marker recognized");
  assert.ok(!isRotateRep("9".repeat(64)), "ordinary rep is not a rotation");
  assert.ok(!isRotateRep("not-an-address"), "garbage rejected");
}

const rot = (from: string, to: string, height: bigint, hash: string): RotationBlock => ({ fromPub: from, toPub: to, height, hash });

// 2. No rotations → current = initial, accepted = {initial}.
{
  const r = applyRotations(new Map([[TOKEN, P0]]), []);
  assert.equal(r.current.get(TOKEN), P0);
  assert.deepEqual([...r.accepted.get(TOKEN)!], [P0]);
}

// 3. Single hop P0→P1: current = P1, legacy keeps P0 (historical deposits bind).
{
  const r = applyRotations(new Map([[TOKEN, P0]]), [rot(P0, P1, 5n, "h1")]);
  assert.equal(r.current.get(TOKEN), P1, "current advances to the successor");
  assert.deepEqual([...r.accepted.get(TOKEN)!].sort(), [P0, P1].sort(), "old pool stays accepted");
}

// 4. Multi-hop P0→P1→P2: follows the whole custody chain.
{
  const r = applyRotations(new Map([[TOKEN, P0]]), [rot(P1, P2, 9n, "h2"), rot(P0, P1, 5n, "h1")]);
  assert.equal(r.current.get(TOKEN), P2, "follows the full chain");
  assert.equal(r.accepted.get(TOKEN)!.size, 3, "all three addresses accepted");
}

// 5. Only the CURRENT pool key can advance the chain: a rotation from a pool
//    that isn't in the chain is ignored (no successor for it).
{
  const attacker = "e".repeat(64);
  const r = applyRotations(new Map([[TOKEN, P0]]), [rot(attacker, P2, 1n, "hx"), rot(P0, P1, 5n, "h1")]);
  assert.equal(r.current.get(TOKEN), P1, "an unrelated pool's rotation can't hijack");
  assert.ok(!r.accepted.get(TOKEN)!.has(P2), "attacker target not accepted");
}

// 6. Cycle guard: P0→P1→P0 terminates.
{
  const r = applyRotations(new Map([[TOKEN, P0]]), [rot(P0, P1, 1n, "h1"), rot(P1, P0, 2n, "h2")]);
  assert.ok(r.current.get(TOKEN) === P1 || r.current.get(TOKEN) === P0, "cycle terminates deterministically");
  assert.ok(r.accepted.get(TOKEN)!.size <= 2, "no infinite growth");
}

// 7. Determinism: two rotations from one pubkey → earliest (height,hash) wins.
{
  const a = applyRotations(new Map([[TOKEN, P0]]), [rot(P0, P1, 5n, "h1"), rot(P0, P2, 5n, "h0")]);
  const b = applyRotations(new Map([[TOKEN, P0]]), [rot(P0, P2, 5n, "h0"), rot(P0, P1, 5n, "h1")]);
  assert.equal(a.current.get(TOKEN), b.current.get(TOKEN), "input-order independent");
  assert.equal(a.current.get(TOKEN), P2, "lowest hash at equal height wins");
}

console.log("✅ pool rotation tests passed");
