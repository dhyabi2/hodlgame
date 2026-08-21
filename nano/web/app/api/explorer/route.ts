import { NextResponse } from "next/server";
import { stats, feed, opDetail, accountView, tokenExplorer, trustDashboard, search } from "../../../server/explorerApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Explorer API (docs/EXPLORER-SPEC.md). Views:
 *   ?view=stats                              overview: totals, TVL, 24h vol, top/latest
 *   ?view=feed[&cursor=&limit=&kind=&token=] paginated, filterable decoded-op feed
 *   ?view=op&q=<hash>                        op: deltas, edges, story, raw blocks, confirmations
 *   ?view=account&q=<a>[&cursor=&limit=]     account: holdings, labels, paginated ops
 *   ?view=token&q=<id>[&holderCursor=]       token: analytics, socials, trades, series, holders
 *   ?view=trust                              proof of reserves
 *   ?view=search&q=<any>                     unified search
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "stats";
  const q = url.searchParams.get("q") ?? "";
  const num = (k: string, d = 0) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) ? v : d; };
  try {
    switch (view) {
      case "stats":
        return NextResponse.json(await stats());
      case "feed":
        return NextResponse.json(await feed({ cursor: num("cursor"), limit: num("limit", 50), kind: url.searchParams.get("kind") || undefined, token: url.searchParams.get("token") || undefined }));
      case "op": {
        const r = await opDetail(q);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "op not found" }, { status: 404 });
      }
      case "account":
        return NextResponse.json(await accountView(q, num("cursor"), num("limit", 50)));
      case "token": {
        const r = await tokenExplorer(q.toLowerCase(), num("holderCursor"));
        return r ? NextResponse.json(r) : NextResponse.json({ error: "unknown token" }, { status: 404 });
      }
      case "trust":
        return NextResponse.json(await trustDashboard());
      case "search":
        return NextResponse.json(await search(q));
      default:
        return NextResponse.json({ error: "unknown view" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
