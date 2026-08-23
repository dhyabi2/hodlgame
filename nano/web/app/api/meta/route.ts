import { NextResponse } from "next/server";
import { loadMetaRow } from "../../../server/tokens";
import { isTokenId } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Light display-metadata lookup (name/symbol/image only) — a single store read,
// NO ledger replay. Exists so the edge-runtime OG image (which can't import the
// node-only durable store) can fetch a coin's card fields over HTTP.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("token") ?? "";
  if (!isTokenId(id)) return NextResponse.json({ error: "bad token" }, { status: 400 });
  const meta = await loadMetaRow(id).catch(() => null);
  return NextResponse.json(
    {
      name: (meta?.name || "").trim(),
      symbol: (meta?.symbol || "").trim(),
      image: (meta?.image || "").trim(),
    },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } }
  );
}
