import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { verifyFetchedBlock } from "./blockSource";

// A real signed state block, as blocks_info would return it.
const secretKey = nanocurrency.deriveSecretKey("5".repeat(64), 0);
const publicKey = nanocurrency.derivePublicKey(secretKey);
const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });

const created = nanocurrency.createBlock(secretKey, {
  work: "0000000000000000",
  previous: "1".repeat(64),
  representative: address,
  balance: "1000000",
  link: "2".repeat(64),
});
const contents = {
  type: "state",
  account: address.replace(/^xrb_/, "nano_"),
  previous: "1".repeat(64),
  representative: address.replace(/^xrb_/, "nano_"),
  balance: "1000000",
  link: "2".repeat(64),
  signature: created.block.signature,
};
const hash = created.hash;

// 1. Genuine block verifies.
assert.ok(verifyFetchedBlock(hash, { block_account: contents.account, contents, amount: "5" }), "genuine block accepted");

// 2. Tampered contents (balance) → hash mismatch → rejected.
assert.ok(
  !verifyFetchedBlock(hash, { block_account: contents.account, contents: { ...contents, balance: "999" }, amount: "5" }),
  "tampered balance rejected"
);

// 3. Forged signature on a value-bearing block → rejected.
assert.ok(
  !verifyFetchedBlock(hash, { block_account: contents.account, contents: { ...contents, signature: "0".repeat(128) }, amount: "5" }),
  "forged signature on deposit rejected"
);

// 4. Bad signature on a ZERO-amount block is kept (epoch-block carve-out — can
//    never be an op or deposit, so it cannot influence state).
assert.ok(
  verifyFetchedBlock(hash, { block_account: contents.account, contents: { ...contents, signature: "0".repeat(128) }, amount: "0" }),
  "valueless epoch-style block tolerated"
);

// 5. Wrong hash entirely → rejected.
assert.ok(!verifyFetchedBlock("f".repeat(64), { block_account: contents.account, contents, amount: "5" }), "wrong hash rejected");

console.log("✅ block verification tests passed");
