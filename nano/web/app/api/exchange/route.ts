import { NextResponse } from "next/server";
import { tokenInfo, tokenBalance, balanceProof, tickers, ohlcv, recentTrades, assetMeta } from "../../../server/exchange";
import { isTokenId, isNanoAddress } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exchange Integration Kit — read-only endpoints (docs/EXCHANGE-KIT.md).
 * Deposit-address derivation and withdrawal are LIBRARIES the exchange runs
 * with its own key (server/exchange.ts, client/exchangeWithdraw.ts) — never
 * hosted, so we never hold exchange keys.
 *   ?view=token-info&q=<tokenId>       symbol/name/DECIMALS(consensus)/price/pool/liquidity/circulating
 *   ?view=balance&token=<id>&account=  balance + the state root that proves it
 *   ?view=balance-proof&token=&account= Merkle inclusion proof (light verify)
 *   ?view=tickers                      CMC/CoinGecko-style markets for EVERY coin
 *   ?view=ohlcv&q=<id>[&interval=3600] price candles from the trade feed
 *   ?view=trades&q=<id>[&limit=200]    recent trades (historical_trades)
 *   ?view=asset&q=<id>                 full listing metadata (logo/socials/supply)
 */
const num = (u: URL, k: string, d: number) => { const v = Number(u.searchParams.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "token-info";
  try {
    if (view === "tickers") {
      return NextResponse.json(await tickers(), { headers: { "Cache-Control": "public, max-age=15, s-maxage=15" } });
    }
    if (view === "ohlcv") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (!isTokenId(q)) return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
      const r = await ohlcv(q, num(url, "interval", 3600), num(url, "limit", 300));
      return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown token" }, { status: 404 });
    }
    if (view === "trades") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (!isTokenId(q)) return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
      const r = await recentTrades(q, num(url, "limit", 200));
      return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown token" }, { status: 404 });
    }
    if (view === "asset") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (!isTokenId(q)) return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
      const r = await assetMeta(q);
      return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown token" }, { status: 404 });
    }
    if (view === "token-info") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (!isTokenId(q)) return NextResponse.json({ error: "tokenId (32 hex) required" }, { status: 400 });
      const info = await tokenInfo(q);
      return info ? NextResponse.json(info) : NextResponse.json({ error: "unknown token" }, { status: 404 });
    }
    if (view === "balance") {
      const token = (url.searchParams.get("token") ?? "").toLowerCase();
      const account = url.searchParams.get("account") ?? "";
      if (!isTokenId(token) || !isNanoAddress(account)) {
        return NextResponse.json({ error: "valid token and account required" }, { status: 400 });
      }
      return NextResponse.json(await tokenBalance(token, account));
    }
    if (view === "balance-proof") {
      const token = (url.searchParams.get("token") ?? "").toLowerCase();
      const account = url.searchParams.get("account") ?? "";
      if (!isTokenId(token) || !isNanoAddress(account)) {
        return NextResponse.json({ error: "valid token and account required" }, { status: 400 });
      }
      return NextResponse.json(await balanceProof(token, account));
    }
    return NextResponse.json({ error: "unknown view" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
