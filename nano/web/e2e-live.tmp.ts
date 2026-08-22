// Live production E2E: exercises the REAL client code (app/lib/trade.ts) against
// https://www.nanocrypto.fun — launch → metadata → seed liquidity → buy → chart
// accuracy → stake → unstake → claim → transfer → sell → sweep payout.
// Micro amounts only (total ≤ ~0.0001 XNO of the funded 0.1).

import * as fs from "node:fs";
import * as nanocurrency from "nanocurrency";

const BASE = "https://www.nanocrypto.fun";

// Route the client code's relative fetches ("/api/rpc", "/api/tokens"…) at prod.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
  return realFetch(url, init);
}) as any;

// Now import the actual client module (its rpc() uses fetch("/api/rpc")).
import {
  rpc, buildBlock, toRaw, quoteBuy,
  execBuy, execSell, execTransfer, sendOp, submitLink, receiveAll, keysFromSeed, fetchXnoBalance,
} from "./app/lib/trade";
import { encodeOpLink } from "./core/oplink";
import { tokenIdFromLaunchHash } from "./core/token";
import { metaFieldsHash, metaSignDigest } from "./core/metaAuth";
import { sanitizeMeta } from "./server/validate";
import { priceOf } from "./server/analytics";

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

/** Poll until pred(token) is truthy (or timeout). Returns last token view. */
async function waitFor(tokenId: string, account: string, label: string, pred: (t: any) => boolean, timeoutMs = 120_000): Promise<any | null> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await detail(tokenId, account);
    if (last && pred(last)) return last;
    await sleep(5000);
  }
  return pred(last ?? {}) ? last : null;
}

async function main() {
  // ── 0. funding ─────────────────────────────────────────────────────────────
  console.log("test wallet:", W0.address);
  const rec = await receiveAll(W0);
  const bal0 = BigInt(await fetchXnoBalance(W0.address));
  console.log(`received ${rec.count} pending; balance = ${bal0} raw`);
  if (bal0 < 10n ** 28n) { // need at least 0.01 XNO
    console.log("NOT FUNDED YET — waiting up to 30 min for funds…");
    const t0 = Date.now();
    let bal = bal0;
    while (bal < 10n ** 28n && Date.now() - t0 < 1_800_000) {
      await sleep(10_000);
      await receiveAll(W0).catch(() => null);
      bal = BigInt(await fetchXnoBalance(W0.address));
    }
    if (bal < 10n ** 28n) { console.log("still unfunded; aborting"); process.exit(2); }
  }
  report("fund + receiveAll", true, `balance ${BigInt(await fetchXnoBalance(W0.address))} raw`);

  // ── resume mode: reuse an existing launched coin ───────────────────────────
  if (process.env.E2E_TOKEN) {
    const tokenId = process.env.E2E_TOKEN;
    let t = await waitFor(tokenId, W0.address, "indexed", (x) => x && x.name && x.pool);
    if (!t) { report("existing coin indexed", false); process.exit(1); }
    report("existing coin indexed", true, `${t.name} (${t.symbol})`);
    await runTrading(tokenId, t);
    return;
  }

  // ── 1. launch a fresh coin (exact client flow from page.tsx launch()) ──────
  const meta0 = { name: "E2E Check", symbol: "E2E", decimals: 6, image: "" as string, description: "automated live verification coin", website: "", twitter: "", telegram: "" };
  // upload a 1px png through the real endpoint
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000" + "01f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "image.png");
  const up = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
  if (!up.url) { report("image upload", false, JSON.stringify(up)); process.exit(1); }
  report("image upload", true, up.url);
  meta0.image = up.url;

  const supplyRaw = 1000n * 10n ** 6n; // 1000 tokens, 6 decimals
  const meta = sanitizeMeta(meta0);
  const launchHash = await submitLink(W0, encodeOpLink("", { kind: "launch", supply: supplyRaw, name: meta.name, symbol: meta.symbol, decimals: 6, image: "" }), 1n);
  const tokenId = tokenIdFromLaunchHash(launchHash);
  console.log("launched tokenId:", tokenId);

  const seq = Date.now();
  const digest = metaSignDigest(tokenId, seq, "update", metaFieldsHash(meta));
  const signature = nanocurrency.signBlock({ hash: digest, secretKey: W0.secretKey });
  const mres = await fetch("/api/tokens", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId, ...meta, account: W0.address, signature, seq, action: "update" }),
  });
  report("launch + signed metadata", mres.ok, `token ${tokenId} meta ${mres.status}`);

  let t = await waitFor(tokenId, W0.address, "indexed", (x) => x && x.name === "E2E Check" && x.pool);
  if (!t) { report("coin indexed with name/image/pool", false); process.exit(1); }
  report("coin indexed with name/image/pool", t.image === meta.image && t.symbol === "E2E", `name=${t.name} pool=${t.pool.slice(0, 12)}…`);
  await runTrading(tokenId, t);
}

async function runTrading(tokenId: string, t: any) {
  // ── 2. seed liquidity (creator deposit + chained seedLiq, page.tsx seed()) ─
  const seedXno = toRaw("0.00001", 30);           // 1e25 raw
  const seedTok = 500n * 10n ** 6n;               // 500 tokens from treasury
  {
    const info = await rpc("account_info", { account: W0.address, representative: "true" });
    const w1 = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
    const blk1 = buildBlock(W0.secretKey, { work: w1, previous: info.frontier, representative: info.representative, balance: (BigInt(info.balance) - seedXno).toString(), link: t.pool });
    const r1 = await rpc("process", { json_block: "true", block: blk1 });
    const opLink = encodeOpLink(tokenId, { kind: "seedLiq", xno: 0n, tokens: seedTok });
    const w2 = (await rpc("work_generate", { hash: r1.hash, difficulty: "fffffff800000000" })).work;
    const blk2 = buildBlock(W0.secretKey, { work: w2, previous: r1.hash, representative: info.representative, balance: (BigInt(info.balance) - seedXno - 1n).toString(), link: opLink });
    await rpc("process", { json_block: "true", block: blk2 });
  }
  t = await waitFor(tokenId, W0.address, "seeded", (x) => x && BigInt(x.poolXno) >= seedXno && BigInt(x.poolTokens) >= seedTok);
  report("seed liquidity", Boolean(t), t ? `pool ${t.poolXno} raw XNO / ${t.poolTokens} raw tokens` : "timeout");
  if (!t) process.exit(1);

  // ── 3. buy (deposit + chained buy op, real execBuy) ────────────────────────
  const priceBefore = BigInt(t.price);
  const buyXno = "0.000001";
  const expectTokens = quoteBuy(t.poolXno, t.poolTokens, toRaw(buyXno, 30));
  await execBuy(W0, t, buyXno, 15);
  t = await waitFor(tokenId, W0.address, "bought", (x) => x && BigInt(x.myBalance) > 50n * 10n ** 6n); // > creatorShare
  const bought = t ? BigInt(t.myBalance) - 50n * 10n ** 6n : 0n;
  report("buy credits tokens", Boolean(t) && bought > 0n, `bought ${bought} raw (quote said ${expectTokens})`);
  report("buy quote matches credit", bought === expectTokens, `${bought} vs ${expectTokens}`);
  report("price rose after buy", Boolean(t) && BigInt(t.price) > priceBefore, `${priceBefore} → ${t?.price}`);
  report("trades tape has the buy", Boolean(t?.trades?.some((tr: any) => tr.kind === "buy" && tr.account === W0.address)));

  // ── 4. chart accuracy ──────────────────────────────────────────────────────
  if (t) {
    const expected = priceOf(BigInt(t.poolXno), BigInt(t.poolTokens), t.decimals);
    const lastPoint = t.series[t.series.length - 1];
    report("chart: price = poolXno*10^dec/poolTokens", BigInt(t.price) === expected, `${t.price} vs ${expected}`);
    report("chart: latest series point = live price", lastPoint && lastPoint.priceRaw === t.price, `${lastPoint?.priceRaw} vs ${t.price}`);
    const timesSorted = t.series.every((p: any, i: number) => i === 0 || p.time >= t.series[i - 1].time);
    report("chart: series timestamps ordered", timesSorted, `${t.series.length} points`);
  }

  // ── 5. stake → unstake (tax→rebate) → claim ────────────────────────────────
  await sendOp(W0, tokenId, { kind: "stake", amount: 20n * 10n ** 6n });
  t = await waitFor(tokenId, W0.address, "staked", (x) => x && BigInt(x.myStaked) === 20n * 10n ** 6n);
  report("stake", Boolean(t), t ? `staked ${t.myStaked} raw` : "timeout");

  await sendOp(W0, tokenId, { kind: "unstake", amount: 10n * 10n ** 6n });
  t = await waitFor(tokenId, W0.address, "unstaked", (x) => x && BigInt(x.myStaked) === 10n * 10n ** 6n);
  report("unstake (20% tax applies)", Boolean(t), t ? `staked now ${t.myStaked}, claimable ${t.myClaimable}` : "timeout");
  const claimable = t ? BigInt(t.myClaimable) : 0n;
  report("unstake tax produced claimable rebate", claimable > 0n, `${claimable} raw`);

  if (claimable > 0n) {
    await sendOp(W0, tokenId, { kind: "claim" });
    t = await waitFor(tokenId, W0.address, "claimed", (x) => x && BigInt(x.myClaimable) === 0n);
    report("claim resets claimable", Boolean(t), t ? `claimable ${t.myClaimable}` : "timeout");
  }

  // ── 6. transfer tokens to wallet 1 ─────────────────────────────────────────
  await execTransfer(W0, t ?? { tokenId, decimals: 6 }, W1.address, "5");
  t = await waitFor(tokenId, W0.address, "transferred", (x) => x?.topHolders?.some((h: any) => h.account === W1.address && BigInt(h.balanceRaw) === 5n * 10n ** 6n));
  report("send tokens (fragment transfer)", Boolean(t), t ? "wallet1 holds 5 tokens" : "timeout");

  // ── 7. sell (fragment links, minXno) + sweep payout ────────────────────────
  const xnoBefore = BigInt(await fetchXnoBalance(W0.address));
  const priceBeforeSell = t ? BigInt(t.price) : 0n;
  await execSell(W0, t ?? { tokenId, decimals: 6, poolXno: "0", poolTokens: "0" }, "40", 15);
  t = await waitFor(tokenId, W0.address, "sold", (x) => x?.trades?.some((tr: any) => tr.kind === "sell" && tr.account === W0.address));
  report("sell indexed on tape", Boolean(t));
  report("price fell after sell", Boolean(t) && BigInt(t.price) < priceBeforeSell, `${priceBeforeSell} → ${t?.price}`);

  // sweep (Vercel cron, every minute) should pay the sell proceeds in XNO
  console.log("waiting for cron sweep payout (up to 4 min)…");
  let paid = false;
  for (let i = 0; i < 24 && !paid; i++) {
    await sleep(10_000);
    await receiveAll(W0).catch(() => null);
    paid = BigInt(await fetchXnoBalance(W0.address)) > xnoBefore;
  }
  report("sell payout arrived via sweep", paid, paid ? `balance rose above ${xnoBefore}` : "no payout within 4 min");

  // ── summary ────────────────────────────────────────────────────────────────
  const fails = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - fails.length}/${results.length} checks passed =====`);
  for (const f of fails) console.log(`FAILED: ${f.step} — ${f.detail}`);
  const finalBal = BigInt(await fetchXnoBalance(W0.address));
  console.log(`test wallet final balance: ${finalBal} raw`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
