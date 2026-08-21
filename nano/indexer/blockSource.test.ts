import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { verifyFetchedBlock, deriveAmountSubtype } from "./blockSource";

const secretKey = nanocurrency.deriveSecretKey("5".repeat(64), 0);
const publicKey = nanocurrency.derivePublicKey(secretKey);
const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true }).replace(/^xrb_/, "nano_");

const created = nanocurrency.createBlock(secretKey, {
  work: "0000000000000000",
  previous: "1".repeat(64),
  representative: address,
  balance: "1000000",
  link: "2".repeat(64),
});
const contents = {
  type: "state",
  account: address,
  previous: "1".repeat(64),
  representative: address,
  balance: "1000000",
  link: "2".repeat(64),
  signature: created.block.signature,
};
const hash = created.hash;

// 1. Genuine block verifies (account bound to signed account).
assert.ok(verifyFetchedBlock(hash, { block_account: address, contents, amount: "5" }), "genuine block accepted");

// 2. OWNER FORGERY: a valid block relabeled to a victim block_account → REJECTED.
const victim = nanocurrency.deriveAddress(
  nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey("6".repeat(64), 0)),
  { useNanoPrefix: true }
).replace(/^xrb_/, "nano_");
assert.ok(
  !verifyFetchedBlock(hash, { block_account: victim, contents, amount: "5" }),
  "block reattributed to a victim account is rejected"
);

// 3. Tampered contents (balance) → hash mismatch → rejected.
assert.ok(
  !verifyFetchedBlock(hash, { block_account: address, contents: { ...contents, balance: "999" }, amount: "5" }),
  "tampered balance rejected"
);

// 4. Forged signature → rejected (NO amount-based carve-out anymore; the epoch
//    tolerance lives in listBlocks and is gated on a zero balance-delta).
assert.ok(
  !verifyFetchedBlock(hash, { block_account: address, contents: { ...contents, signature: "0".repeat(128) }, amount: "0" }),
  "forged signature rejected regardless of claimed amount"
);

// 5. AMOUNT FORGERY is structurally impossible now: verifyFetchedBlock ignores
//    amount, and deriveAmountSubtype computes it from signed balances only.
{
  // send: balance 1000 → 900 ⇒ amount 100, subtype send (node's claimed amount irrelevant)
  const send = deriveAmountSubtype("900", "1".repeat(64), 1000n);
  assert.deepEqual(send, { amount: "100", subtype: "send" }, "send amount from balance delta");
  const recv = deriveAmountSubtype("1100", "1".repeat(64), 1000n);
  assert.deepEqual(recv, { amount: "100", subtype: "receive" }, "receive amount from balance delta");
  const open = deriveAmountSubtype("500", "0".repeat(64), 0n);
  assert.deepEqual(open, { amount: "500", subtype: "open" }, "open amount from balance");
  const epoch = deriveAmountSubtype("1000", "1".repeat(64), 1000n);
  assert.deepEqual(epoch, { amount: "0", subtype: "change" }, "unchanged balance ⇒ inert (amount 0)");
}

console.log("✅ block verification tests passed");
