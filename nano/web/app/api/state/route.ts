import { NextResponse } from "next/server";
import { MultiIndexer } from "../../../indexer/multiIndexer";
import { NanoRpcSource } from "../../../indexer/blockSource";
import { tokenPoolKeys } from "../../../server/custody";
import { registryMetaResolver } from "../../../server/tokens";
import { loadNanoRpcKey } from "../../../lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const watched = (process.env.WATCHED_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const master = process.env.POOL_SEED ?? "";

  try {
    const idx = new MultiIndexer(new NanoRpcSource(loadNanoRpcKey()), registryMetaResolver());
    await idx.sync(watched);

    const tokens = [...idx.getState()].map(([tokenId, s]) => ({
      tokenId,
      name: s.name,
      symbol: s.symbol,
      decimals: s.decimals,
      image: s.image,
      launched: s.launched,
      supply: s.supply.toString(),
      creator: s.creator,
      creatorShare: s.creatorShare.toString(),
      treasury: s.treasury.toString(),
      poolXno: s.poolXno.toString(),
      poolTokens: s.poolTokens.toString(),
      totalStaked: s.totalStaked.toString(),
      pool: master ? tokenPoolKeys(master, tokenId).address : null,
      balances: Object.fromEntries([...s.balances].map(([k, v]) => [k, v.toString()])),
    }));

    return NextResponse.json({ tokens });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}