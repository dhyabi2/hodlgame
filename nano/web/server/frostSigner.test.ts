import { strict as assert } from "node:assert";
import { frostEnabled, frostSignPayout } from "./frostSigner";
import type { PoolKeys, Payout } from "./custody";

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

  // 2. Sends the correct block (balance = frontier balance − amount) + context,
  //    returns the coordinator's signed block.
  const orig = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ block: { signature: "SIGNED", link: captured.block.link } }) } as any;
  }) as any;

  const block = await frostSignPayout(pool, "ab".repeat(16), payout);
  globalThis.fetch = orig;

  assert.equal(block.signature, "SIGNED", "returns coordinator's signed block");
  assert.equal(captured.block.balance, "4000000", "balance = 5,000,000 − 1,000,000");
  assert.equal(captured.block.link, "nano_seller", "link = recipient");
  assert.deepEqual(
    captured.context,
    { type: "holdfun-payout", tokenId: "ab".repeat(16), to: "nano_seller", amountRaw: "1000000" },
    "policy context carries tokenId/to/amount for the cosigner to verify"
  );

  // 3. Coordinator error / no block → throws (never returns an unsigned block).
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ error: "no quorum" }) }) as any) as any;
  await assert.rejects(() => frostSignPayout(pool, "ab".repeat(16), payout), /no quorum/);
  globalThis.fetch = orig;

  delete process.env.FROST_COORDINATOR_URL;
  console.log("✅ FROST coordinator client tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
