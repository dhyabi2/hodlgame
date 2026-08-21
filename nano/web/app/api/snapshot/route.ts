import { NextResponse } from "next/server";
import { exportSnapshot } from "../../../server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only epoch snapshot of the residual off-chain state. Default returns
 * just the hash (cheap); ?full=1 returns the canonical JSON so anyone can
 * mirror it and verify against the on-chain anchor (server/snapshot.ts). */
export async function GET(req: Request) {
  try {
    const snap = await exportSnapshot();
    const full = new URL(req.url).searchParams.get("full") === "1";
    return full
      ? new NextResponse(snap.json, {
          headers: { "Content-Type": "application/json", "X-Snapshot-Hash": snap.hash },
        })
      : NextResponse.json({ hash: snap.hash, bytes: snap.json.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
