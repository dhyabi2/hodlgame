import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import { withdrawToken, type WithdrawState } from "./exchangeWithdraw";

// A mock Nano RPC that tracks broadcast blocks and simulates a linear chain.
function mockRpc() {
  const processed: any[] = [];
  const seed = "a".repeat(64);
  const address = nanocurrency.deriveAddress(
    nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey(seed, 0)),
    { useNanoPrefix: true }
  );
  let frontier = "1".repeat(64);
  let balance = "1000000";
  const byHash: Record<string, any> = {};
  const rpc = async (action: string, params: any) => {
    if (action === "account_info") return { frontier, representative: address, balance };
    if (action === "work_generate") return { work: "0000000000000000" };
    if (action === "process") {
      processed.push(params.block);
      frontier = processed.length.toString(16).padStart(64, "0"); // valid 64-hex
      byHash[frontier] = { contents: params.block };
      balance = params.block.balance;
      return { hash: frontier };
    }
    if (action === "block_info") return byHash[params.hash] ?? null;
    return {};
  };
  return { rpc, processed, address, seed };
}

async function main() {
  const to = nanocurrency.deriveAddress(
    nanocurrency.derivePublicKey(nanocurrency.deriveSecretKey("2".repeat(64), 0)),
    { useNanoPrefix: true }
  );
  const req = { id: "wd-1", tokenId: "ab".repeat(16), to, amount: "1000000" };

  // 1. Fresh withdrawal broadcasts exactly two chained blocks (frag A + B).
  {
    const { rpc, processed } = mockRpc();
    const st = await withdrawToken("a".repeat(64), req, rpc);
    assert.ok(st.done && st.fragAHash && st.fragBHash, "both fragments sent, done");
    assert.equal(processed.length, 2, "exactly two blocks");
    // Frag B chains from frag A.
    assert.equal(processed[1].previous, st.fragAHash, "frag B.previous = frag A.hash");
    // Each is a 1-raw data send (balance drops by 1 each).
    assert.equal(BigInt(processed[0].balance), 999999n);
    assert.equal(BigInt(processed[1].balance), 999998n);
  }

  // 2. Idempotent resume: a persisted state with frag A already sent skips A.
  {
    const { rpc, processed } = mockRpc();
    // Seed the mock so block_info(fragA) resolves for the balance-after-A read.
    const seededA = (await rpc("process", { block: { balance: "999999", representative: "x" } })).hash;
    const partial: WithdrawState = { ...req, fragAHash: seededA, done: false };
    const st = await withdrawToken("a".repeat(64), req, rpc, partial);
    assert.ok(st.done, "completes from a partial state");
    // Only frag B is newly broadcast (plus our seeding block) — A not resent.
    assert.equal(processed.length, 2, "resume sends only frag B (1) + the seed (1)");
  }

  // 3. Already-done state is a no-op.
  {
    const { rpc, processed } = mockRpc();
    const doneSt: WithdrawState = { ...req, fragAHash: "h1", fragBHash: "h2", done: true };
    const st = await withdrawToken("a".repeat(64), req, rpc, doneSt);
    assert.equal(st, doneSt);
    assert.equal(processed.length, 0, "no blocks broadcast for a completed withdrawal");
  }

  console.log("✅ exchange withdrawal (two-block, idempotent) tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
