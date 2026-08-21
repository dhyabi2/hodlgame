"use client";

import { useEffect, useRef } from "react";

// Live incoming-payment detection over the Nano confirmation websocket. Pattern
// adapted from the verifyXNO project. wss://ws.nano.to is a nano.to endpoint,
// consistent with the strict RPC policy (nano.to primary). Subscribes to the
// account's confirmations and fires onIncoming for any send whose destination
// (block.link == our public key) credits us — so the UI can auto-receive the
// moment a deposit confirms, no polling.

const WS_URL = "wss://ws.nano.to";

export function useNanoWebsocket(
  account: string | null,
  publicKey: string | null,
  onIncoming: (amountRaw: string, sendHash: string) => void
) {
  const reconnectRef = useRef(0);
  const onIncomingRef = useRef(onIncoming);
  useEffect(() => { onIncomingRef.current = onIncoming; }, [onIncoming]);

  useEffect(() => {
    if (!account || !publicKey) return;
    let active = true;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pk = publicKey.toLowerCase();

    function connect() {
      if (!active) return;
      try {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          reconnectRef.current = 0;
          ws?.send(JSON.stringify({
            action: "subscribe",
            topic: "confirmation",
            options: { accounts: [account] },
          }));
        };
        ws.onmessage = async (event) => {
          try {
            const raw = event.data instanceof Blob ? await event.data.text() : event.data;
            const data = JSON.parse(raw);
            if (data?.topic !== "confirmation") return;
            const link = String(data.message?.block?.link ?? "").toLowerCase();
            const amount = String(data.message?.amount ?? "0");
            // A send's destination is encoded in the link field; match ours.
            if (link === pk && BigInt(amount) > 0n) {
              onIncomingRef.current(amount, String(data.message?.hash ?? ""));
            }
          } catch { /* ignore malformed */ }
        };
        ws.onclose = () => {
          if (!active) return;
          reconnectRef.current = Math.min(reconnectRef.current + 1, 6);
          timer = setTimeout(connect, Math.min(1000 * 2 ** reconnectRef.current, 30000));
        };
      } catch {
        timer = setTimeout(connect, 5000);
      }
    }
    connect();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [account, publicKey]);
}
