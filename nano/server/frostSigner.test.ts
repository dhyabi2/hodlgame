import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { frostEnabled, frostSignPayout } from "./frostSigner";
import type { PoolKeys, Payout } from "./custody";

function keysFrom(seedChar: string): PoolKeys {
  const secretKey = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  return { secretKey, publicKey, address: nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true }) };
}
const pool: PoolKeys = { address: "nano_pool", publicKey: "ab".repeat(32), secretKey: "cd".repeat(32) };
const payout: Payout = {
  to: "nano_seller",
  amountRaw: "1000000",
  frontier: "f".repeat(64),
  balance: "5000000",
  representative: "nano_rep",
};

async function main() {
  // 1. Opt-in: disabled unless FROST_COORDINATOR_URL is set.
  delete process.env.FROST_COORDINATOR_URL;
  assert.equal(frostEnabled(), false, "disabled by default (single-key fallback)");
  process.env.FROST_COORDINATOR_URL = "http://coord.local";
  assert.equal(frostEnabled(), true, "enabled when coordinator URL set");

  // 2. Sends the block hash + policy context, assembles a broadcastable block
  //    (balance = frontier balance − amount, link = recipient pubkey, group sig,
  //    PoW). Use a real recipient so derivePublicKey/hashBlock succeed.
  const seller = nanocurrency.deriveAddress(
    nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey("9".repeat(64), 0)),
    { useNanoPrefix: true }
  );
  const realPool = keysFrom("8");
  const realPayout: Payout = { ...payout, to: seller, frontier: "1".repeat(64), representative: realPool.address };

  const orig = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (u: any, init: any) => {
    if (String(u).includes("/sign")) {
      captured = JSON.parse(init.body);
      return { ok: true, json: async () => ({ signature: "a".repeat(128) }) } as any;
    }
    // work_generate proxy
    return { ok: true, json: async () => ({ work: "0000000000000000" }) } as any;
  }) as any;

  const block = await frostSignPayout(realPool, "ab".repeat(16), realPayout);
  globalThis.fetch = orig;

  assert.equal(block.signature, "A".repeat(128), "group signature set (uppercased)");
  assert.equal(block.balance, "4000000", "balance = 5,000,000 − 1,000,000");
  assert.equal(block.link.toLowerCase(), nanocurrency.derivePublicKey(seller).toLowerCase(), "link = recipient pubkey");
  assert.ok(block.work, "PoW attached");
  assert.match(captured.blockHash, /^[0-9A-F]{64}$/, "block hash sent to coordinator");
  assert.deepEqual(
    captured.context,
    { type: "holdfun-payout", tokenId: "ab".repeat(16), to: seller, amountRaw: "1000000" },
    "policy context carries tokenId/to/amount for the cosigner to verify"
  );

  // 3. Coordinator error / no signature → throws (never broadcasts unsigned).
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ error: "no quorum" }) }) as any) as any;
  await assert.rejects(() => frostSignPayout(realPool, "ab".repeat(16), realPayout), /no quorum/);
  globalThis.fetch = orig;

  delete process.env.FROST_COORDINATOR_URL;
  console.log("✅ FROST coordinator client tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
