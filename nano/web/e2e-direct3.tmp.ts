// Final phase of the Direct-Settlement live E2E: W1 sells its remaining ZCC
// position (appreciation should queue), then W0's queue-routed buy pays W1's
// wallet directly with real XNO. TEMP — delete after use.
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
import { receiveAll, keysFromSeed, fetchXnoBalance, execBuyDirect, execSell } from "./app/lib/trade";

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
  let t = await waitFor(W1.address, (x) => x?.direct === true && BigInt(x.myBalance || "0") > 0n);
  if (!t) { report("stable state indexed (W1 still holds tokens)", false, JSON.stringify(await detail(W1.address))?.slice(0, 300)); process.exit(1); }
  report("stable state indexed", true, `W1 tokens=${t.myBalance} earmark=${t.myEarmark}`);

  const w1PreSell = BigInt(await fetchXnoBalance(W1.address));
  await execSell(W1, t, (Number(BigInt(t.myBalance)) / 1e6).toString(), 0);
  t = await waitFor(W1.address, (x) => BigInt(x?.myBalance || "0") === 0n);
  if (!t) { report("sell-all indexed", false); process.exit(1); }
  const queued = BigInt(t.myQueueOwed || "0");
  report("sell-all indexed", true, `earmark left=${t.myEarmark} queued=${queued} coverage=${t.coveragePct}%`);

  if (queued > 0n) {
    t = await detail(W0.address);
    if (!t.queueHead || t.queueHead.account !== W1.address) { report("queue head is W1", false, JSON.stringify(t.queueHead)); process.exit(1); }
    report("queue head is W1", true, `owed=${t.queueHead.owedRaw}`);
    const w1PosBefore = BigInt(await fetchXnoBalance(W1.address));
    await execBuyDirect(W0, t, (Number(queued) / 1e30).toFixed(30).replace(/0+$/, "").replace(/\.$/, ""), 0);
    t = await waitFor(W1.address, (x) => BigInt(x?.myQueueOwed || "0") === 0n);
    report("queue drained by routed buy", Boolean(t), t ? `queueTotal=${t.queueTotal}` : "");
    await sleep(3000);
    await receiveAll(W1);
    const w1Final = BigInt(await fetchXnoBalance(W1.address));
    const gained = w1Final - w1PosBefore;
    report("real XNO landed in W1's wallet", gained >= queued, `gained=${gained} raw (claim was ${queued})`);
  } else {
    report("appreciation queued", false, "sell produced no queued claim (fully self-netted)");
  }

  console.log("\n══ SUMMARY ══");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.step}  ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
