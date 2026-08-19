import { NextResponse } from "next/server";

/**
 * Server-side RPC proxy.
 *
 * The client used to talk to Helius directly via `NEXT_PUBLIC_RPC_URL`, which
 * meant the API key was inlined into the JS bundle — readable by anyone who
 * opened devtools, and billable to us by anyone who copied it. The key now
 * lives in `RPC_URL` (no NEXT_PUBLIC_ prefix), so it stays on the server and
 * the browser only ever sees this same-origin route.
 */

const UPSTREAM =
  process.env.RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ?? // legacy fallback so a missed env var doesn't hard-fail
  "https://api.devnet.solana.com";

export const runtime = "edge";
// Never cache: every call is a fresh chain read or a transaction submission.
export const dynamic = "force-dynamic";

/**
 * Only methods the app actually uses. An open proxy would let anyone route
 * arbitrary traffic through our paid endpoint.
 */
const ALLOWED = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getLatestBlockhash",
  "getSignaturesForAddress",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "getSlot",
  "getBlockHeight",
  "getEpochInfo",
  "getVersion",
  "getHealth",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "isBlockhashValid",
  "getGenesisHash",
]);

function methodsOf(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body.map((entry) =>
      entry && typeof entry === "object" ? String((entry as any).method ?? "") : ""
    );
  }
  if (body && typeof body === "object") {
    return [String((body as any).method ?? "")];
  }
  return [];
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const methods = methodsOf(body);
  if (methods.length === 0) {
    return NextResponse.json({ error: "No RPC method specified" }, { status: 400 });
  }
  const blocked = methods.filter((m) => !ALLOWED.has(m));
  if (blocked.length > 0) {
    return NextResponse.json(
      { error: `RPC method not allowed: ${blocked.join(", ")}` },
      { status: 403 }
    );
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Pass the upstream status through so the client's backoff still sees 429s.
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("rpc proxy error", err);
    return NextResponse.json({ error: "Upstream RPC unreachable" }, { status: 502 });
  }
}

/** Solana's web3.js probes the endpoint with GET in some paths. */
export async function GET() {
  return NextResponse.json({ ok: true, proxy: "holder-rpc" });
}
