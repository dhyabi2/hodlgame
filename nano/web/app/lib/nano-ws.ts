"use client";

import { useEffect, useRef } from "react";

// Live chain events over the Nano confirmation websocket.
//
// Nano's websocket is a SUBSCRIPTION protocol, not a second RPC transport —
// probed live: `ping` answers `pong`, the topics below ack and deliver, and any
// RPC action (account_info, blocks_info, process, …) gets NO response at all.
// So this cannot replace a single request; what it replaces is POLLING. Instead
// of asking "has anything changed?" every N seconds, the browser is told the
// moment a block involving its accounts confirms.
//
// Nothing here signs, and nothing here can. Blocks are built and signed in
// app/lib/trade.ts with a secret key that never leaves the device; this socket
// is read-only and carries no credentials. The server endpoint /api/ws only
// hands over the URL and topic list.

const DEFAULT_WS_URL = "wss://ws.nano.to";
const PING_MS = 30_000;

/** One confirmed block, as the socket reports it. */
export interface NanoConfirmation {
  hash: string;
  /** The account that published the block. */
  account: string;
  /** For a send, the destination public key (hex). */
  link: string;
  /** Raw amount moved. */
  amount: string;
  subtype?: string;
}

/** Resolved once per page load, then reused. Falls back to the default if the
 * endpoint is unreachable, so a config fetch failure can never cost the app its
 * live updates. */
let wsUrlPromise: Promise<string> | null = null;
function resolveWsUrl(): Promise<string> {
  if (!wsUrlPromise) {
    wsUrlPromise = fetch("/api/ws")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (typeof j?.url === "string" && j.url.startsWith("wss://") ? j.url : DEFAULT_WS_URL))
      .catch(() => DEFAULT_WS_URL);
  }
  return wsUrlPromise;
}

/**
 * Subscribe to confirmations for `accounts` and fire `onConfirm` for each one.
 *
 * Fires for blocks the accounts PUBLISH as well as blocks that pay them, so it
 * covers "my trade confirmed" and "someone paid me" with one subscription.
 */
export function useNanoConfirmations(accounts: (string | null | undefined)[], onConfirm: (c: NanoConfirmation) => void) {
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => { onConfirmRef.current = onConfirm; }, [onConfirm]);

  // Join the list so the effect re-runs when the SET changes, not on every
  // render (a fresh array literal would otherwise reconnect the socket forever).
  const key = accounts.filter(Boolean).join(",");

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (list.length === 0) return;
    let active = true;
    let ws: WebSocket | null = null;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const connect = async () => {
      if (!active) return;
      const url = await resolveWsUrl();
      if (!active) return;
      try {
        ws = new WebSocket(url);
        ws.onopen = () => {
          retry = 0;
          ws?.send(JSON.stringify({ action: "subscribe", topic: "confirmation", ack: true, options: { accounts: list } }));
          // Keepalive: idle sockets get dropped by intermediaries, and a dead
          // socket that never errors is indistinguishable from a quiet chain.
          pingTimer = setInterval(() => {
            try { ws?.send(JSON.stringify({ action: "ping" })); } catch {}
          }, PING_MS);
        };
        ws.onmessage = async (event) => {
          try {
            const raw = event.data instanceof Blob ? await event.data.text() : event.data;
            const data = JSON.parse(raw);
            if (data?.topic !== "confirmation") return; // acks and pongs are not events
            const block = data.message?.block ?? {};
            onConfirmRef.current({
              hash: String(data.message?.hash ?? ""),
              account: String(data.message?.account ?? block.account ?? ""),
              link: String(block.link ?? "").toLowerCase(),
              amount: String(data.message?.amount ?? "0"),
              subtype: block.subtype ? String(block.subtype) : undefined,
            });
          } catch { /* ignore malformed frames */ }
        };
        const scheduleReconnect = () => {
          if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
          if (!active) return;
          retry = Math.min(retry + 1, 6);
          reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000));
        };
        ws.onclose = scheduleReconnect;
        ws.onerror = () => { try { ws?.close(); } catch { scheduleReconnect(); } };
      } catch {
        reconnectTimer = setTimeout(connect, 5000);
      }
    };
    void connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      ws?.close();
    };
  }, [key]);
}

/**
 * Incoming-payment detection: fires only for confirmed sends whose destination
 * is this account. Kept as its own hook because the auto-receive flow wants
 * exactly that and nothing else.
 */
export function useNanoWebsocket(
  account: string | null,
  publicKey: string | null,
  onIncoming: (amountRaw: string, sendHash: string) => void
) {
  const onIncomingRef = useRef(onIncoming);
  useEffect(() => { onIncomingRef.current = onIncoming; }, [onIncoming]);
  const pk = (publicKey ?? "").toLowerCase();

  useNanoConfirmations(publicKey ? [account] : [], (c) => {
    // A send's destination is encoded in the link field; match ours.
    if (pk && c.link === pk && BigInt(c.amount || "0") > 0n) onIncomingRef.current(c.amount, c.hash);
  });
}
