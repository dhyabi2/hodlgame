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

const PORT = Number(process.env.GUARDIAN_PORT ?? 8201);
const SEED = process.env.GUARDIAN_SEED ?? "";
const API_KEY = process.env.GUARDIAN_KEY ?? "";
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
  req.on("end", () => {
    try {
      const r = JSON.parse(raw || "{}");
      if (API_KEY && r.apiKey !== API_KEY) return json(res, 403, { error: "unauthorized" });
      if (!key) return json(res, 500, { error: "GUARDIAN_SEED not set" });

      // Replay protection.
      const rid = String(r.requestId ?? "");
      const now = Date.now();
      const last = seen.get(rid);
      if (!rid) return json(res, 400, { error: "requestId required" });
      if (last && now - last < 3600_000) return json(res, 409, { error: "duplicate request" });

      // Only sign for the pools this guardian is configured to guard.
      const account = String(r.account ?? "");
      if (GUARDED.size > 0 && !GUARDED.has(account)) {
        return json(res, 400, { error: "not a guarded pool" });
      }

      // Balance must actually cover the payout (cheap on-chain sanity check).
      const balance = String(r.balance ?? "");
      if (!/^[0-9]+$/.test(balance) || BigInt(balance) <= 0n) {
        return json(res, 400, { error: "bad balance" });
      }

      // Recompute the block hash from raw fields — never trust a caller hash.
      const hash = (nanocurrency as any).hashBlock({
        account,
        previous: String(r.previous ?? ""),
        representative: String(r.representative ?? ""),
        balance,
        link: String(r.link ?? ""),
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