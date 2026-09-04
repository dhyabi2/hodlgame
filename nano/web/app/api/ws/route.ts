import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Websocket capability descriptor for the browser.
 *
 * Nano's websocket is a SUBSCRIPTION protocol, not a second RPC transport.
 * Probed live against wss://ws.nano.to (2026-09-04):
 *
 *   ping                   → ack "pong"
 *   confirmation           → ack, delivers blocks as they confirm
 *   vote                   → ack
 *   stopped_election       → ack
 *   work                   → ack
 *   telemetry              → ack, high volume
 *   new_unconfirmed_block  → ack, firehose
 *   bootstrap              → ack
 *   active_difficulty      → NO ack (not served here)
 *   account_info (or any other RPC action) → NO response at all
 *
 * So nothing that returns data on request — account_info, blocks_info,
 * account_history, process — can be moved onto it. What it CAN remove is
 * polling: instead of asking "has anything changed?" on a timer, the client is
 * told the moment a block involving its accounts confirms.
 *
 * This endpoint hands the browser the URL and the supported topic list so the
 * client does not hardcode them and the socket can be repointed without a
 * client release. It is pure configuration: no key, no secret, and no signing —
 * the browser connects to the public socket itself. Signing stays entirely in
 * the client (app/lib/trade.ts builds and signs every block with a secret key
 * that never leaves the device), and this endpoint neither accepts nor returns
 * anything that could change that.
 */
const WS_URL = process.env.NANO_WS_URL || "wss://ws.nano.to";

const TOPICS = ["confirmation", "vote", "stopped_election", "work", "telemetry", "new_unconfirmed_block", "bootstrap"] as const;

export async function GET() {
  return NextResponse.json({
    url: WS_URL,
    topics: TOPICS,
    // Named so a client cannot mistake the socket for an RPC transport.
    rpcOverWebsocket: false,
    unsupportedTopics: ["active_difficulty"],
    keepalive: { action: "ping", expect: "pong" },
    // How to subscribe to just the accounts you care about.
    example: { action: "subscribe", topic: "confirmation", ack: true, options: { accounts: ["nano_..."] } },
  });
}
