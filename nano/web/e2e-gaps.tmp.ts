// Live tests for the remaining UNTESTED e2e paths on prod (hodlgame.fun):
//  A. pooled withdraw op → cron sweep → REAL pool payout lands in the wallet
//  B. stake / unstake (tax→rebate) / claim on a DIRECT (zero-custody) token
//  C. addLiq on a direct token (virtual, frag pair)
//  D. defection void: strip a wallet below its collateral floor → position
//     shrinks proportionally, observed from prod's replay
// TEMP — delete after use.
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
import { rpc, keysFromSeed, fetchXnoBalance, receiveAll, submitLink, buildBlock, toRaw } from "./app/lib/trade";
import { encodeOpLink } from "./core/oplink";
import { encodeFragLinks } from "./core/fraglink";

const DIRECT = "78e7ba60509a47475350f2f3c9134445"; // ZCC (zero-custody)
const POOLED = "cd864f9bb7efcdfcdeb23d8f3d68834d"; // E2E Check (legacy pooled)
const seed = fs.readFileSync("/private/tmp/claude-501/-Users-mac-holdergame/c6057717-2a03-49a1-9f32-edaea98a1044/scratchpad/test-seed.txt", "utf-8").trim();
const envText = fs.readFileSync("/private/tmp/claude-501/-Users-mac-holdergame/c6057717-2a03-49a1-9f32-edaea98a1044/scratchpad/prod.env", "utf-8");
const CRON_SECRET = /CRON_SECRET="?([^"\n]+)"?/.exec(envText)?.[1] ?? "";
const W0 = keysFromSeed(seed);
const sk1 = nanocurrency.deriveSecretKey(seed, 1);
const W1 = { secretKey: sk1, publicKey: nanocurrency.derivePublicKey(sk1), address: nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk1), { useNanoPrefix: true }) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; detail: string }[] = [];
const report = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? " — " + detail : ""}`);
};
async function view(token: string, account = ""): Promise<any | null> {
  try {
    const j = await (await fetch(`/api/token?token=${token}&account=${account}&_=${Date.now()}`)).json();
    return j.token ?? null;
  } catch { return null; }
}
async function waitFor(token: string, account: string, pred: (t: any) => boolean, timeoutMs = 240_000): Promise<any | null> {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await view(token, account);
    if (last && pred(last)) return last;
    await sleep(6000);
  }
  return last && pred(last) ? last : null;
}
async function sendXno(from: typeof W0, toPub: string, amountRaw: bigint) {
  const info = await rpc("account_info", { account: from.address, representative: "true" });
  const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
  const blk = buildBlock(from.secretKey, {
    work, previous: info.frontier, representative: info.representative,
    balance: (BigInt(info.balance) - amountRaw).toString(), link: toPub,
  });
  return (await rpc("process", { json_block: "true", block: blk })).hash as string;
}

async function main() {
  // ── A. pooled withdraw → sweep → real payout ──────────────────────────────
  {
    const t = await view(POOLED, W0.address);
    const credit = BigInt(t?.myCredit ?? "0");
    if (credit <= 0n) report("A: pooled credit precondition", false, t?.myCredit);
    else {
      await submitLink(W0, encodeOpLink(POOLED, { kind: "withdraw" }), 1n);
      const t2 = await waitFor(POOLED, W0.address, (x) => BigInt(x?.myCredit ?? "1") === 0n);
      report("A1: withdraw op zeroes credit", Boolean(t2), `credit was ${credit}`);
      const balBefore = BigInt(await fetchXnoBalance(W0.address));
      const res = await fetch("/api/cron/sweep", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
      const j = await res.json().catch(() => ({}));
      report("A2: sweep cron ran", res.ok, JSON.stringify(j).slice(0, 160));
      let gained = 0n;
      for (let i = 0; i < 20 && gained < credit; i++) {
        await sleep(6000);
        await receiveAll(W0).catch(() => null);
        gained = BigInt(await fetchXnoBalance(W0.address)) - balBefore;
      }
      report("A3: pool paid REAL XNO for the withdrawal", gained >= credit, `gained=${gained} owed=${credit}`);
    }
  }

  // ── B. direct-token stake / unstake / claim ───────────────────────────────
  {
    let t = await view(DIRECT, W1.address);
    const w1Tok = BigInt(t?.myBalance ?? "0"); // W1 holds 1 ZCC from the transfer test
    if (w1Tok <= 0n) report("B: W1 holds ZCC precondition", false);
    else {
      await submitLink(W1, encodeOpLink(DIRECT, { kind: "stake", amount: w1Tok }), 1n); // W1 stakes all
      t = await waitFor(DIRECT, W1.address, (x) => BigInt(x?.myStaked ?? "0") === w1Tok);
      report("B1: stake on direct token", Boolean(t), `W1 staked ${w1Tok}`);

      const t0 = await view(DIRECT, W0.address);
      const w0Tok = BigInt(t0?.myBalance ?? "0");
      const stakeAmt = 10_000_000n < w0Tok ? 10_000_000n : w0Tok / 2n;
      await submitLink(W0, encodeOpLink(DIRECT, { kind: "stake", amount: stakeAmt }), 1n);
      await waitFor(DIRECT, W0.address, (x) => BigInt(x?.myStaked ?? "0") >= stakeAmt);
      await submitLink(W0, encodeOpLink(DIRECT, { kind: "unstake", amount: stakeAmt }), 1n); // 20% tax → rebate to W1
      const tw1 = await waitFor(DIRECT, W1.address, (x) => BigInt(x?.myClaimable ?? "0") > 0n);
      report("B2: unstake tax rebates remaining staker", Boolean(tw1), tw1 ? `W1 claimable=${tw1.myClaimable}` : "");
      if (tw1) {
        const before = BigInt(tw1.myBalance);
        await submitLink(W1, encodeOpLink(DIRECT, { kind: "claim" }), 1n);
        const done = await waitFor(DIRECT, W1.address, (x) => BigInt(x?.myBalance ?? "0") > before && BigInt(x?.myClaimable ?? "1") === 0n);
        report("B3: claim pays banked rebate", Boolean(done), done ? `W1 balance ${before}→${done.myBalance}` : "");
      }
    }
  }

  // ── C. addLiq on a direct token (virtual, frag) ───────────────────────────
  {
    const t = await view(DIRECT, "");
    const px = BigInt(t.poolXno), pt = BigInt(t.poolTokens);
    const addTok = 1_000_000n;
    const [fa, fb] = encodeFragLinks(DIRECT, { kind: "addLiq", xno: toRaw("0.00001", 30), tokens: addTok });
    await submitLink(W0, fa, 1n);
    await submitLink(W0, fb, 1n);
    const t2 = await waitFor(DIRECT, "", (x) => BigInt(x.poolXno) > px && BigInt(x.poolTokens) > pt);
    report("C: direct addLiq grows virtual reserves", Boolean(t2), t2 ? `poolXno ${px}→${t2.poolXno}` : "");
  }

  // ── D. defection void: strip below the floor → position shrinks ───────────
  {
    // W1 self-earmark buy (queue must be empty)
    const t = await view(DIRECT, W1.address);
    if (BigInt(t.queueTotal ?? "0") > 0n) report("D: queue-empty precondition", false, t.queueTotal);
    else {
      const buyRaw = toRaw("0.00001", 30);
      const w1XnoBefore = BigInt(await fetchXnoBalance(W1.address));
      const [fa, fb] = encodeFragLinks(DIRECT, { kind: "buy", xno: buyRaw, minTokens: 0n });
      await submitLink(W1, fa, 1n);
      await submitLink(W1, fb, 1n);
      const t2 = await waitFor(DIRECT, W1.address, (x) => BigInt(x?.myEarmark ?? "0") >= buyRaw);
      if (!t2) { report("D1: earmark created", false); }
      else {
        const tokBefore = BigInt(t2.myBalance);
        const floor = BigInt(t2.myFloor);
        report("D1: earmark created", true, `earmark=${t2.myEarmark} floor=${floor} tokens=${tokBefore}`);
        // strip: send W0 everything except floor/2 — a real defection
        const keep = floor / 2n;
        const toSend = w1XnoBefore - keep;
        await sendXno(W1, W0.publicKey, toSend);
        const t3 = await waitFor(DIRECT, W1.address, (x) => BigInt(x?.myFloor ?? "999999999999999999999999999999") <= keep && BigInt(x?.myBalance ?? "0") < tokBefore, 300_000);
        report("D2: defection voided proportionally", Boolean(t3), t3 ? `floor→${t3.myFloor} tokens ${tokBefore}→${t3.myBalance}` : "");
        // restore W1's funds
        await sendXno(W0, W1.publicKey, toSend);
        await sleep(3000);
        await receiveAll(W1).catch(() => null);
      }
    }
  }

  console.log("\n══ SUMMARY ══");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
