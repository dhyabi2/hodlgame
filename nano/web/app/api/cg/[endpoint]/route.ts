import { NextResponse } from "next/server";
import { cgTickers, cgPairs, cgHistoricalTrades, pairOrderbook } from "../../../../server/exchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CoinGecko-spec-exact endpoints for a DEX/exchange listing submission:
//   /api/cg/tickers            market tickers (base=coin, target=XNO)
//   /api/cg/pairs              tradeable pairs
//   /api/cg/historical_trades?ticker_id=<id>_XNO&type=buy|sell&limit=  trades
//   /api/cg/orderbook?ticker_id=<id>_XNO                              AMM spot level
const CACHE = { "Cache-Control": "public, max-age=15, s-maxage=15" };

export async function GET(req: Request, { params }: { params: { endpoint: string } }) {
  const url = new URL(req.url);
  try {
    switch (params.endpoint) {
      case "tickers":
        return NextResponse.json(await cgTickers(), { headers: CACHE });
      case "pairs":
        return NextResponse.json(await cgPairs(), { headers: CACHE });
      case "historical_trades": {
        const id = url.searchParams.get("ticker_id") ?? "";
        const type = url.searchParams.get("type") ?? "";
        const limit = Number(url.searchParams.get("limit")) || 200;
        const r = await cgHistoricalTrades(id, type, limit);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown ticker_id" }, { status: 404 });
      }
      case "orderbook": {
        const id = url.searchParams.get("ticker_id") ?? "";
        const r = await pairOrderbook(id);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown ticker_id" }, { status: 404 });
      }
      default:
        return NextResponse.json({ error: "unknown endpoint" }, { status: 404 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
