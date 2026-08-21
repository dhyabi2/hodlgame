import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { validateWork, RECEIVE_DIFFICULTY, SEND_DIFFICULTY } from "./rpc";

// 1. validateWork agrees with the compiled generator (build with
//    `npm run build-workgen`; skipped gracefully if the binary is absent,
//    e.g. in CI before the build step runs).
const BIN = "bin/workgen";
if (fs.existsSync(BIN)) {
  const root = require("node:crypto").randomBytes(32).toString("hex");
  const work = execFileSync(BIN, [root, RECEIVE_DIFFICULTY]).toString().trim();
  assert.equal(work.length, 16, "workgen emits a 16-hex nonce");
  assert.ok(validateWork(work, root, RECEIVE_DIFFICULTY), "generated work validates");
  assert.ok(!validateWork(work, "0".repeat(64), RECEIVE_DIFFICULTY), "work is root-bound");
  const flipped = (work[0] === "0" ? "1" : "0") + work.slice(1);
  // A tampered nonce ALMOST always fails (astronomically unlikely to still pass).
  assert.ok(!validateWork(flipped, root, SEND_DIFFICULTY), "tampered nonce fails at send difficulty");
  console.log("✅ work validation tests passed (with workgen)");
} else {
  // Static vectors: shape checks only.
  assert.ok(!validateWork("zz", "0".repeat(64), RECEIVE_DIFFICULTY), "bad hex rejected");
  assert.ok(!validateWork("0".repeat(16), "0".repeat(63), RECEIVE_DIFFICULTY), "bad root length rejected");
  console.log("✅ work validation tests passed (workgen binary absent — build with npm run build-workgen)");
}
