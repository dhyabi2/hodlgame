import { NextResponse } from "next/server";
import { feed, opDetail, accountView, tokenExplorer, trustDashboard, search } from "../../../server/explorerApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Explorer API (docs/EXPLORER-SPEC.md).
 *   ?view=feed            latest decoded ops with state deltas
 *   ?view=op&q=<hash>     one op: deltas, edges, payout coverage
 *   ?view=account&q=<a>   account page data
 *   ?view=token&q=<id>    token explorer data (holders, reserves, history)
 *   ?view=trust           root, proof-of-reserves, obligations, snapshot
 *   ?view=search&q=<any>  unified search (routes to the right view)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "feed";
  const q = url.searchParams.get("q") ?? "";
  try {
    switch (view) {
      case "feed":
        return NextResponse.json(await feed());
      case "op": {
        const r = await opDetail(q);
        return r ? NextResponse.json(r) : NextResponse.json({ error: "op not found" }, { status: 404 });
      }
      case "account":
        return NextResponse.json(await accountView(q));
      case "token": {
        const r = await tokenExplorer(q.toLowerCase());
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
