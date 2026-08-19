import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { serverConnection, getPriceHistory } from "@/lib/server/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { mint: string } }
) {
  let mint: PublicKey;
  try {
    mint = new PublicKey(params.mint);
  } catch {
    return NextResponse.json({ error: "bad mint" }, { status: 400 });
  }

  try {
    const connection = serverConnection();
    const decimals = await getMint(connection, mint)
      .then((m) => m.decimals)
      .catch(() => 6);
    const points = await getPriceHistory(connection, mint, decimals);
    return NextResponse.json(
      { mint: params.mint, points },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
        },
      }
    );
  } catch (err) {
    console.error("price history failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
