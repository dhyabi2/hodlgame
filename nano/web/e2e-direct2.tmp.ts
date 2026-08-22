// Continuation of e2e-direct.tmp.ts after the RPC cache-buster fix: the ZCC
// coin (78e7ba60...) is already launched + virtually seeded. Runs steps 3-6:
// self-earmark buy → price-up buy → sell (instant + queued) → queue-routed
// buy paying the seller wallet-to-wallet. TEMP — delete after use.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

const BASE = "https://www.hodlgame.fun";
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
  return realFetch(url, init);
}) as any;
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import { rpc, receiveAll, keysFromSeed, fetchXnoBalance, execBuyDirect, execSell, toRaw } from "./app/lib/trade";

const TOKEN = "78e7ba60509a47475350f2f3c9134445";
const seed = fs.readFileSync("/private/tmp/claude-501/-Users-mac-holdergame/c6057717-2a03-49a1-9f32-edaea98a1044/scratchpad/test-seed.txt", "utf-8").trim();
const W0 = keysFromSeed(seed);
const sk1 = nanocurrency.deriveSecretKey(seed, 1);
const W1 = { secretKey: sk1, publicKey: nanocurrency.derivePublicKey(sk1), address: nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk1), { useNanoPrefix: true }) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; detail: string }[] = [];
const report = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? " — " + detail : ""}`);
};
async function detail(account = ""): Promise<any | null> {
  try {
    const j = await (await fetch(`/api/token?token=${TOKEN}&account=${account}&_=${Date.now()}`)).json();
    return j.token ?? null;
  } catch { return null; }
}
async function waitFor(account: string, pred: (t: any) => boolean, timeoutMs = 240_000): Promise<any | null> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await detail(account);
    if (last && pred(last)) return last;
    await sleep(6000);
  }
  return last && pred(last) ? last : null;
}

async function main() {
  const BUY1 = toRaw("0.00002", 30);

  let t = await waitFor(W1.address, (x) => x?.direct === true && BigInt(x.poolXno || "0") > 0n);
  if (!t) { report("indexed direct+seeded", false); process.exit(1); }
  report("indexed direct+seeded", true, `poolXno=${t.poolXno} (virtual)`);

  // ── 3. W1 self-earmark buy: XNO must NOT leave W1's wallet ─────────────────
  if (BigInt(t.myEarmark || "0") === 0n) {
    const w1Before = BigInt(await fetchXnoBalance(W1.address));
    await execBuyDirect(W1, t, "0.00002", 0);
    const w1AfterBuy = BigInt(await fetchXnoBalance(W1.address));
    report("buy: XNO stayed in wallet", w1Before - w1AfterBuy === 2n, `Δ=${w1Before - w1AfterBuy} raw (2 frag blocks)`);
  }
  t = await waitFor(W1.address, (x) => BigInt(x?.myEarmark || "0") === BUY1 && BigInt(x?.myBalance || "0") > 0n);
  if (!t) { report("earmark indexed", false, JSON.stringify(await detail(W1.address))); process.exit(1); }
  report("earmark indexed", true, `earmark=${t.myEarmark} floor=${t.myFloor} tokens=${t.myBalance}`);

  // ── 4. W0 buys after W1 (price up for W1) ─────────────────────────────────
  t = await detail(W0.address);
  if (BigInt(t.myEarmark || "0") === 0n) {
    await execBuyDirect(W0, t, "0.00004", 0);
  }
  t = await waitFor(W0.address, (x) => BigInt(x?.myEarmark || "0") > 0n);
  report("second self-earmark buy", Boolean(t), t ? `W0 earmark=${t.myEarmark}` : "");

  // ── 5. W1 sells ALL: instant earmark release + queued appreciation ────────
  t = await detail(W1.address);
  const w1PreSell = BigInt(await fetchXnoBalance(W1.address));
  await execSell(W1, t, (Number(BigInt(t.myBalance)) / 1e6).toString(), 0);
  const w1PostSell = BigInt(await fetchXnoBalance(W1.address));
  report("sell: no on-chain payout needed", w1PreSell - w1PostSell <= 2n, `Δ=${w1PreSell - w1PostSell} raw (principal was ALREADY in the wallet)`);

  t = await waitFor(W1.address, (x) => BigInt(x?.myBalance || "0") === 0n && BigInt(x?.myEarmark || "0") === 0n);
  if (!t) { report("sell indexed", false, JSON.stringify(await detail(W1.address))); process.exit(1); }
  const queued = BigInt(t.myQueueOwed || "0");
  report("sell indexed: earmark fully released", true, `queued appreciation=${queued} coverage=${t.coveragePct}%`);

  // ── 6. queue-routed buy: W0 pays W1 DIRECTLY, wallet to wallet ────────────
  if (queued > 0n) {
    t = await detail(W0.address);
    if (!t.queueHead) { report("queue head visible", false, String(t.queueTotal)); process.exit(1); }
    report("queue head visible", t.queueHead.account === W1.address, `owed=${t.queueHead.owedRaw}`);
    await execBuyDirect(W0, t, (Number(queued) / 1e30).toFixed(30).replace(/0+$/, ""), 0);
    t = await waitFor(W1.address, (x) => BigInt(x?.myQueueOwed || "0") === 0n && BigInt(x?.queueTotal || "0") === 0n);
    report("queue drained by routed buy", Boolean(t));
    await sleep(3000);
    await receiveAll(W1);
    const w1Final = BigInt(await fetchXnoBalance(W1.address));
    const gained = w1Final - w1PostSell;
    report("real XNO landed in seller's wallet", gained >= queued, `gained=${gained} raw (queued was ${queued})`);
  } else {
    report("appreciation queued", false, "no queued amount");
  }

  console.log("\n══ SUMMARY ══");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
