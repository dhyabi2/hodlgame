// Guardian co-signer (2-of-3). Holds ONE cosigner share (derived from the
// master seed + GUARDIAN_INDEX) and co-signs a payout block hash — but only
// after independently re-verifying that the block targets a pool account this
// guardian co-guards. Run one process per index (1 or 2) on separate infra.
//
//   MASTER_SEED=... GUARDIAN_INDEX=1 GUARDIAN_KEY=... npm run guardian
//
// POST /sign  { apiKey, tokenId, account, previous, representative, balance, link }
//   200  { signature, publicKey }

import * as http from "node:http";
import * as nanocurrency from "nanocurrency";
import { tokenPoolKeys, cosignerSeeds } from "./custody";
import { keysFromSeed } from "../client/nano";

const PORT = Number(process.env.GUARDIAN_PORT ?? 8201);
const INDEX = Number(process.env.GUARDIAN_INDEX ?? 1);
const MASTER = process.env.MASTER_SEED ?? "";
const API_KEY = process.env.GUARDIAN_KEY ?? "";

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

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
      if (!MASTER) return json(res, 500, { error: "MASTER_SEED not set" });
      if (typeof r.tokenId !== "string" || typeof r.account !== "string") {
        return json(res, 400, { error: "tokenId and account required" });
      }

      const pool = tokenPoolKeys(MASTER, r.tokenId);
      if (r.account !== pool.address) return json(res, 400, { error: "not a guarded pool" });

      // Recompute the block hash from the raw fields (never trust a caller hash).
      const hash = (nanocurrency as any).hashBlock({
        account: r.account,
        previous: r.previous,
        representative: r.representative,
        balance: r.balance,
        link: r.link,
      });

      const seed = cosignerSeeds(MASTER, r.tokenId)[INDEX - 1];
      if (!seed) return json(res, 400, { error: "bad guardian index" });
      const k = keysFromSeed(seed);
      const signature = (nanocurrency as any).signBlock({ hash, secretKey: k.secretKey });
      return json(res, 200, { signature, publicKey: k.publicKey });
    } catch (e: any) {
      return json(res, 400, { error: e?.message ?? String(e) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`guardian #${INDEX} listening on :${PORT} (pool ${MASTER ? "configured" : "unconfigured"})`);
});