import { NextResponse } from "next/server";
import { replayState } from "../../../server/indexer";
import { poolKeysFromSeed } from "../../../server/custody";
import { loadNanoRpcKey } from "../../../lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const META = {
  name: process.env.TOKEN_NAME ?? "HoldFun",
  symbol: process.env.TOKEN_SYMBOL ?? "HOLD",
  decimals: Number(process.env.TOKEN_DECIMALS ?? 6),
  image: process.env.TOKEN_IMAGE ?? "",
};

export async function GET() {
  const watched = (process.env.WATCHED_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pool = process.env.POOL_SEED ? poolKeysFromSeed(process.env.POOL_SEED) : null;
  try {
    const { state, events } = await replayState(loadNanoRpcKey(), META, watched);
    return NextResponse.json({
      pool: pool?.address ?? null,
      meta: META,
      launched: state.launched,
      name: state.name,
      symbol: state.symbol,
      supply: state.supply.toString(),
      creator: state.creator,
      creatorShare: state.creatorShare.toString(),
      treasury: state.treasury.toString(),
      rebateVault: state.rebateVault.toString(),
      totalStaked: state.totalStaked.toString(),
      poolXno: state.poolXno.toString(),
      poolTokens: state.poolTokens.toString(),
      events,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
