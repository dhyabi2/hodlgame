import { NextResponse } from "next/server";
import { tokenInfo, tokenBalance, balanceProof } from "../../../server/exchange";
import { isTokenId, isNanoAddress } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exchange Integration Kit — read-only endpoints (docs/EXCHANGE-KIT.md).
 * Deposit-address derivation and withdrawal are LIBRARIES the exchange runs
 * with its own key (server/exchange.ts, client/exchangeWithdraw.ts) — never
 * hosted, so we never hold exchange keys.
 *   ?view=token-info&q=<tokenId>       symbol/name/DECIMALS(consensus)/price/pool
 *   ?view=balance&token=<id>&account=  balance + the state root that proves it
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "token-info";
  try {
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
