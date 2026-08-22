// TEMPORARY diagnostic v3 — replay the E2E test wallet's chain exactly like
// compute() does (same poolKey from POOL_SEED, keyed source) and report the
// decoded events + resulting pool state, so we can see WHERE the valid
// seedLiq gets dropped on prod. Delete after use.
import { NextResponse } from "next/server";
import { MultiIndexer } from "../../../indexer/multiIndexer";
import { NanoRpcSource } from "../../../indexer/blockSource";
import { EMPTY_META } from "../../../server/tokens";
import { commitResolver } from "../../../server/commits";
import { analyze } from "../../../server/analytics";
import { tokenPoolKeys } from "../../../server/custody";
import { loadNanoRpcKey } from "../../../lib/rpc";
import * as nanoRpcMod from "../../../lib/rpc";
import { watchedAccounts } from "../../../server/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const W = "nano_1fcbzc7yxqp1zy5ywo8rkq5pzdw8cgnc3hucpsmw6zhx999tfk3nofb5tge4";
const TOKEN = "cd864f9bb7efcdfcdeb23d8f3d68834d";

export async function GET() {
  const out: any = {};
  try {
    const view = async (fn: () => Promise<any>) => { try { const i = await fn(); return { h: Number(i?.block_count ?? 0) }; } catch (e: any) { return { err: String(e?.message).slice(0, 60) }; } };
    const fb = async () => {
      const r = await fetch("https://rpc.nano-gpt.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "account_info", account: W }) });
      return r.json();
    };
    out.views = {
      keyed: await view(() => nanoRpcMod.nanoRpc(loadNanoRpcKey(), { action: "account_info", account: W })),
      keyless: await view(() => nanoRpcMod.nanoRpc("", { action: "account_info", account: W })),
      fallback: await view(fb),
    };
    const master = process.env.POOL_SEED ?? "";
    out.hasMaster = Boolean(master);
    const poolKey = (tokenId: string) => (master ? tokenPoolKeys(master, tokenId).publicKey : null);
    out.expectedPoolPub = poolKey(TOKEN)?.slice(0, 16);
    const src = new NanoRpcSource(loadNanoRpcKey());
    const idx = new MultiIndexer(src, () => EMPTY_META, await commitResolver(), poolKey);

    const walletBlocks = await src.listBlocks(W);
    out.walletChain = walletBlocks.map((b) => ({ h: b.height.toString(), subtype: b.subtype, link: b.link.slice(0, 16), amount: b.amount?.toString() }));

    // replay just the wallet (like the local probe that WORKS)
    const soloEvents = await idx.collectEvents([W]);
    out.soloEvents = soloEvents.map((e: any) => ({ kind: e.op?.kind, xno: String(e.op?.xno ?? ""), tokens: String(e.op?.tokens ?? "") }));
    const solo = analyze(soloEvents).state.get(TOKEN);
    out.soloPool = { poolXno: solo?.poolXno?.toString(), poolTokens: solo?.poolTokens?.toString() };

    // replay the full watched set (like compute() does)
    const watched = await watchedAccounts();
    out.watched = watched.length;
    out.watchedHasW = watched.includes(W);
    const idx2 = new MultiIndexer(src, () => EMPTY_META, await commitResolver(), poolKey);
    const fullEvents = await idx2.collectEvents(watched);
    out.fullEventsForToken = fullEvents.filter((e: any) => e.tokenId === TOKEN).map((e: any) => ({ kind: e.op?.kind, xno: String(e.op?.xno ?? "") }));
    const full = analyze(fullEvents).state.get(TOKEN);
    out.fullPool = { poolXno: full?.poolXno?.toString(), poolTokens: full?.poolTokens?.toString() };
  } catch (e: any) {
    out.fatal = e?.message ?? String(e);
  }
  return NextResponse.json(out);
}
