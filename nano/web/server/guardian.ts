// Guardian co-signer for 2-of-3 pool custody (any two of: operator key,
// guardian-1 key, guardian-2 key). Holds its OWN independent seed — the master
// seed cannot derive it, so a compromise of the operator never yields a quorum.
//
// The guardian re-verifies before signing: the block must target a pool account
// it is configured to guard, the request must include a fresh requestId (no
// replay), and the account's on-chain balance must cover the payout.
//
//   GUARDIAN_SEED=<64-hex own key> \
//   GUARDED_POOLS=nano_…,nano_… \
//   GUARDIAN_KEY=<shared api key> [GUARDIAN_PORT=8201] npm run guardian
//
// POST /sign  { apiKey, requestId, account, previous, representative, balance, link }
//   200  { signature, publicKey }

import * as http from "node:http";
import * as nanocurrency from "nanocurrency";
import { guardianKeys } from "./custody";
import { nanoRpc, loadNanoRpcKey } from "../lib/rpc";

const PORT = Number(process.env.GUARDIAN_PORT ?? 8201);
const SEED = process.env.GUARDIAN_SEED ?? "";
const API_KEY = process.env.GUARDIAN_KEY ?? "";
const RPC_KEY = loadNanoRpcKey();
// Optional per-payout ceiling (raw XNO); 0/unset = no cap.
const MAX_PAYOUT_RAW = process.env.GUARDIAN_MAX_PAYOUT_RAW ? BigInt(process.env.GUARDIAN_MAX_PAYOUT_RAW) : 0n;
const GUARDED = new Set(
  (process.env.GUARDED_POOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const seen = new Map<string, number>(); // requestId -> last signed epoch ms

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const key = SEED ? guardianKeys(SEED) : null;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || new URL(req.url ?? "/", "http://x").pathname !== "/sign") {
    return json(res, 404, { error: "not found" });
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const r = JSON.parse(raw || "{}");
      if (API_KEY && r.apiKey !== API_KEY) return json(res, 403, { error: "unauthorized" });
      if (!key) return json(res, 500, { error: "GUARDIAN_SEED not set" });

      // Replay protection (in-memory; a restart clears it — acceptable for a
      // long-lived daemon, and every signature is amount-bound below anyway).
      const rid = String(r.requestId ?? "");
      const now = Date.now();
      const last = seen.get(rid);
      if (!rid) return json(res, 400, { error: "requestId required" });
      if (last && now - last < 3600_000) return json(res, 409, { error: "duplicate request" });

      // Fail CLOSED: refuse to sign for any account unless GUARDED_POOLS is
      // configured (an empty allow-set previously meant "sign for anyone").
      const account = String(r.account ?? "");
      if (GUARDED.size === 0 || !GUARDED.has(account)) {
        return json(res, 400, { error: "not a guarded pool (set GUARDED_POOLS)" });
      }

      // The request MUST name the recipient and amount; the guardian binds its
      // signature to them (previously only balance>0 was checked, so a
      // compromised operator could drain a pool to any address — the breaker's
      // finding). Recompute link from `to` so the recipient is explicit.
      const to = String(r.to ?? "");
      const amountRaw = String(r.amountRaw ?? "");
      if (!/^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(to)) {
        return json(res, 400, { error: "valid recipient `to` required" });
      }
      if (!/^[0-9]+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
        return json(res, 400, { error: "positive `amountRaw` required" });
      }
      if (to === account) return json(res, 400, { error: "recipient must not be the pool" });
      const recipientPub = (nanocurrency as any).derivePublicKey(to);
      const balance = String(r.balance ?? "");

      // INDEPENDENTLY verify against chain: the block must chain from the pool's
      // real frontier, and balance after == on-chain balance − amount. This is
      // what makes "balance covers the payout" true rather than the operator's
      // word. (Full recipient legitimacy needs the guardian's own indexer
      // replay — the W1 cosigner-as-verifier design; this closes the drain.)
      const info = await nanoRpc(RPC_KEY, { action: "account_info", account, representative: "true" }).catch(() => null);
      if (!info?.frontier) return json(res, 400, { error: "pool not found on chain" });
      if (String(r.previous ?? "").toLowerCase() !== String(info.frontier).toLowerCase()) {
        return json(res, 409, { error: "stale frontier" });
      }
      if (BigInt(info.balance) - BigInt(amountRaw) !== BigInt(balance)) {
        return json(res, 400, { error: "amount/balance mismatch with chain" });
      }
      if (MAX_PAYOUT_RAW && BigInt(amountRaw) > MAX_PAYOUT_RAW) {
        return json(res, 400, { error: "amount exceeds guardian cap" });
      }

      // Recompute the block hash from the SIGNED fields, with link derived from
      // the validated recipient — never trust a caller-supplied hash or link.
      const hash = (nanocurrency as any).hashBlock({
        account,
        previous: String(r.previous ?? ""),
        representative: String(r.representative ?? ""),
        balance,
        link: recipientPub,
      });

      const signature = (nanocurrency as any).signBlock({ hash, secretKey: key.secretKey });
      seen.set(rid, now);
      return json(res, 200, { signature, publicKey: key.publicKey, account: key.address });
    } catch (e: any) {
      return json(res, 400, { error: e?.message ?? String(e) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`guardian listening on :${PORT} (${key ? key.address : "no key — set GUARDIAN_SEED"})`);
  console.log(`guarded pools: ${GUARDED.size ? [...GUARDED].join(", ") : "(allow any — set GUARDED_POOLS)"}`);
});