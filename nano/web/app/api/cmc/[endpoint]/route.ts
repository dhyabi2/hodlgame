import { NextResponse } from "next/server";
import { cmcSummary, cmcAssets, cmcTicker, cmcTrades, pairOrderbook } from "../../../../server/exchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CoinMarketCap-spec-exact endpoints for an exchange/DEX listing submission:
//   /api/cmc/summary                 24h summary keyed by market pair
//   /api/cmc/assets                  asset details keyed by tokenId
//   /api/cmc/ticker                  price+volume keyed by market pair
//   /api/cmc/trades?market_pair=<id>_XNO[&limit=]   recent trades
//   /api/cmc/orderbook?market_pair=<id>_XNO         AMM spot level
const CACHE = { "Cache-Control": "public, max-age=15, s-maxage=15" };

export async function GET(req: Request, { params }: { params: { endpoint: string } }) {
  const url = new URL(req.url);
  // CMC forms accept the pair via ?market_pair= or the trailing path segment.
  const pair = url.searchParams.get("market_pair") ?? url.searchParams.get("ticker_id") ?? "";
  try {
    switch (params.endpoint) {
      case "summary":
        return NextResponse.json(await cmcSummary(), { headers: CACHE });
      case "assets":
        return NextResponse.json(await cmcAssets(), { headers: CACHE });
      case "ticker":
        return NextResponse.json(await cmcTicker(), { headers: CACHE });
      case "trades": {
        const limit = Number(url.searchParams.get("limit")) || 200;
        const r = await cmcTrades(pair, limit);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown market_pair" }, { status: 404 });
      }
      case "orderbook": {
        const r = await pairOrderbook(pair);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown market_pair" }, { status: 404 });
      }
      default:
        return NextResponse.json({ error: "unknown endpoint" }, { status: 404 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
