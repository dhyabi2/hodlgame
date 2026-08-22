// Live production E2E for Direct-Settlement (zero-custody) tokens against
// https://www.hodlgame.fun — launchV2 → metadata → VIRTUAL seed (no deposit) →
// self-earmark buy (XNO never leaves the wallet) → second buy (price up) →
// sell (instant earmark release + queued appreciation) → queue-routed buy
// (real XNO lands in the seller's wallet, wallet-to-wallet). Micro amounts.
// TEMP file — delete after use.

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

const BASE = "https://www.hodlgame.fun";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
  return realFetch(url, init);
}) as any;

// localStorage shim — WITHOUT it ensureHello throws mid-check and injects
// hello blocks between fragment pairs, garbling every frag op.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import { rpc, submitLink, receiveAll, keysFromSeed, fetchXnoBalance, execBuyDirect, execSeedDirect, execSell, toRaw } from "./app/lib/trade";
import { encodeOpLink } from "./core/oplink";
import { tokenIdFromLaunchHash } from "./core/token";
import { metaFieldsHash, metaSignDigest } from "./core/metaAuth";
import { sanitizeMeta } from "./server/validate";

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

async function detail(tokenId: string, account = ""): Promise<any | null> {
  try {
    const j = await (await fetch(`/api/token?token=${tokenId}&account=${account}`)).json();
    return j.token ?? null;
  } catch { return null; }
}
async function waitFor(tokenId: string, account: string, label: string, pred: (t: any) => boolean, timeoutMs = 180_000): Promise<any | null> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await detail(tokenId, account);
    if (last && pred(last)) return last;
    await sleep(6000);
  }
  return last && pred(last) ? last : null;
}

async function main() {
  const b0 = await fetchXnoBalance(W0.address);
  const b1 = await fetchXnoBalance(W1.address);
  console.log("W0", W0.address, b0, "raw");
  console.log("W1", W1.address, b1, "raw");

  // W1 needs spendable XNO for its self-earmark buy (it must HOLD the amount).
  const BUY1 = toRaw("0.00002", 30);
  await receiveAll(W1).catch(() => null);
  let w1bal = BigInt(await fetchXnoBalance(W1.address));
  if (w1bal < BUY1 * 2n) {
    // top up from W0: plain send + W1 receive
    const info = await rpc("account_info", { account: W0.address, representative: "true" });
    const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
    const blk = {
      type: "state", account: W0.address, previous: info.frontier, representative: info.representative,
      balance: (BigInt(info.balance) - BUY1 * 3n).toString(), link: W1.publicKey, work,
      signature: "",
    } as any;
    const signature = nanocurrency.signBlock({ hash: nanocurrency.hashBlock({ account: W0.address, previous: info.frontier, representative: info.representative, balance: blk.balance, link: W1.publicKey }), secretKey: W0.secretKey });
    blk.signature = signature;
    await rpc("process", { json_block: "true", block: blk });
    await sleep(3000);
    await receiveAll(W1);
    w1bal = BigInt(await fetchXnoBalance(W1.address));
    report("top up W1", w1bal >= BUY1 * 2n, `W1 balance ${w1bal}`);
  }

  // ── 1. launch a zero-custody coin ──────────────────────────────────────────
  const meta0 = { name: "Zero Custody Check", symbol: "ZCC", decimals: 6, image: "" as string, description: "direct-settlement live verification coin", website: "", twitter: "", telegram: "" };
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000" + "01f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "image.png");
  const up = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
  if (!up.url) { report("image upload", false, JSON.stringify(up)); process.exit(1); }
  meta0.image = up.url;

  const supplyRaw = 1000n * 10n ** 6n; // 1000 tokens, 6 decimals
  const meta = sanitizeMeta(meta0);
  const launchHash = await submitLink(W0, encodeOpLink("", { kind: "launch", supply: supplyRaw, name: meta.name, symbol: meta.symbol, decimals: 6, image: "", direct: true }), 1n);
  const tokenId = tokenIdFromLaunchHash(launchHash);
  report("launchV2 (direct)", true, tokenId);

  const seq = Date.now();
  const digest = metaSignDigest(tokenId, seq, "update", metaFieldsHash(meta));
  const signature = nanocurrency.signBlock({ hash: digest, secretKey: W0.secretKey });
  const mres = await fetch("/api/tokens", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId, ...meta, account: W0.address, signature, seq, action: "update" }),
  });
  report("metadata", mres.ok, String(mres.status));

  // ── 2. VIRTUAL seed: no deposit — W0's balance must not drop beyond 2 raw ──
  const w0Before = BigInt(await fetchXnoBalance(W0.address));
  await execSeedDirect(W0, tokenId, "0.0001", 500n * 10n ** 6n); // 500 tokens vs 0.0001 virtual XNO
  const w0After = BigInt(await fetchXnoBalance(W0.address));
  report("virtual seed costs only 2 raw", w0Before - w0After === 2n, `Δ=${w0Before - w0After} raw`);

  let t = await waitFor(tokenId, W0.address, "seeded", (x) => x?.direct === true && BigInt(x.poolXno || "0") > 0n);
  if (!t) { report("indexed direct+seeded", false); process.exit(1); }
  report("indexed direct+seeded", true, `poolXno=${t.poolXno} (virtual)`);

  // ── 3. W1 self-earmark buy: XNO must NOT leave W1's wallet ─────────────────
  const w1Before = BigInt(await fetchXnoBalance(W1.address));
  t = await detail(tokenId, W1.address);
  await execBuyDirect(W1, t, "0.00002", 0);
  const w1AfterBuy = BigInt(await fetchXnoBalance(W1.address));
  report("buy: XNO stayed in wallet", w1Before - w1AfterBuy === 2n, `Δ=${w1Before - w1AfterBuy} raw (2 frag blocks)`);

  t = await waitFor(tokenId, W1.address, "earmarked", (x) => BigInt(x?.myEarmark || "0") === BUY1 && BigInt(x?.myBalance || "0") > 0n);
  if (!t) { report("earmark indexed", false, JSON.stringify(await detail(tokenId, W1.address))); process.exit(1); }
  report("earmark indexed", true, `earmark=${t.myEarmark} floor=${t.myFloor} tokens=${t.myBalance}`);

  // ── 4. W0 buys after W1 (price up for W1) ─────────────────────────────────
  t = await detail(tokenId, W0.address);
  await execBuyDirect(W0, t, "0.00004", 0);
  t = await waitFor(tokenId, W0.address, "second buy", (x) => BigInt(x?.myEarmark || "0") > 0n);
  report("second self-earmark buy", Boolean(t), t ? `W0 earmark=${t.myEarmark}` : "");

  // ── 5. W1 sells ALL: instant earmark release + queued appreciation ────────
  t = await detail(tokenId, W1.address);
  const w1PreSell = BigInt(await fetchXnoBalance(W1.address));
  await execSell(W1, t, (Number(BigInt(t.myBalance)) / 1e6).toString(), 0);
  const w1PostSell = BigInt(await fetchXnoBalance(W1.address));
  report("sell: no on-chain payout needed", w1PreSell - w1PostSell <= 2n, `Δ=${w1PreSell - w1PostSell} raw (op only — principal was ALREADY in the wallet)`);

  t = await waitFor(tokenId, W1.address, "sold", (x) => BigInt(x?.myBalance || "0") === 0n && BigInt(x?.myEarmark || "0") === 0n);
  if (!t) { report("sell indexed", false, JSON.stringify(await detail(tokenId, W1.address))); process.exit(1); }
  const queued = BigInt(t.myQueueOwed || "0");
  report("sell indexed: earmark fully released", true, `queued appreciation=${queued} coverage=${t.coveragePct}%`);

  // ── 6. queue-routed buy: W0 pays W1 DIRECTLY, wallet to wallet ────────────
  if (queued > 0n) {
    t = await detail(tokenId, W0.address);
    if (!t.queueHead) { report("queue head visible", false, JSON.stringify(t.queueTotal)); process.exit(1); }
    report("queue head visible", t.queueHead.account === W1.address, `head=${t.queueHead.account.slice(0, 12)} owed=${t.queueHead.owedRaw}`);
    await execBuyDirect(W0, t, (Number(queued) / 1e30).toFixed(30).replace(/0+$/, ""), 0);
    t = await waitFor(tokenId, W1.address, "queue drained", (x) => BigInt(x?.myQueueOwed || "0") === 0n && BigInt(x?.queueTotal || "0") === 0n);
    report("queue drained by routed buy", Boolean(t));
    // the money must ACTUALLY be in W1's wallet (pending or received)
    await sleep(3000);
    const rcv = await receiveAll(W1);
    const w1Final = BigInt(await fetchXnoBalance(W1.address));
    const gained = w1Final - w1PostSell;
    report("real XNO landed in seller's wallet", gained >= queued, `gained=${gained} raw (queued was ${queued})`);
  } else {
    report("appreciation queued", false, "no queued amount — W0's buy may not have moved the price enough");
  }

  console.log("\n══ SUMMARY ══");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
