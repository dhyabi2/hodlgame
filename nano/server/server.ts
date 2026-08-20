// Operator server: indexer + single-key custody behind a minimal HTTP API.
//
//   NANO_RPC_KEY=... POOL_SEED=<32B hex> TOKEN_NAME=... TOKEN_SYMBOL=... \
//   WATCHED_ACCOUNTS=comma,sep npm run operator
//
// Endpoints:
//   GET  /health                 liveness
//   GET  /state                  replayed token state
//   GET  /balance/:account       a user's token balance
//   POST /sweep                  process sells → sign + broadcast XNO payouts

import * as http from "node:http";
import { replayState } from "./indexer";
import { poolKeysFromSeed } from "./custody";
import { loadNanoRpcKey, nanoRpc } from "../lib/rpc";
import { keysFromSeed } from "../client/nano";

const PORT = Number(process.env.PORT ?? 8080);

function meta() {
  return {
    name: process.env.TOKEN_NAME ?? "HoldFun",
    symbol: process.env.TOKEN_SYMBOL ?? "HOLD",
    decimals: Number(process.env.TOKEN_DECIMALS ?? 6),
    image: process.env.TOKEN_IMAGE ?? "",
  };
}

function watched(): string[] {
  const raw = process.env.WATCHED_ACCOUNTS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function pool(): { address: string; publicKey: string } | null {
  const seed = process.env.POOL_SEED;
  if (!seed) return null;
  const k = poolKeysFromSeed(seed);
  return { address: k.address, publicKey: k.publicKey };
}

async function state() {
  const key = loadNanoRpcKey();
  const { state } = await replayState(key, meta(), watched());
  return {
    launched: state.launched,
    name: state.name,
    symbol: state.symbol,
    supply: state.supply.toString(),
    creator: state.creator,
    creatorShare: state.creatorShare.toString(),
    treasury: state.treasury.toString(),
    rebateVault: state.rebateVault.toString(),
    totalStaked: state.totalStaked.toString(),
    poolXno: state.poolXno.toString(),
    poolTokens: state.poolTokens.toString(),
  };
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, pool: pool()?.address ?? null });
    }
    if (url.pathname === "/state") {
      return json(res, 200, await state());
    }
    if (url.pathname.startsWith("/balance/")) {
      const acct = url.pathname.slice("/balance/".length);
      const key = loadNanoRpcKey();
      const { state } = await replayState(key, meta(), watched());
      const bal = state.balances.get(acct) ?? 0n;
      return json(res, 200, { account: acct, balance: bal.toString() });
    }
    if (url.pathname === "/sweep" && req.method === "POST") {
      return json(res, 200, { note: "sweep: sells detected; payouts not yet wired (custody v1)" });
    }
    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`HoldFun operator listening on :${PORT}`);
  console.log("pool:", pool()?.address ?? "(not set — set POOL_SEED)");
  console.log("watched accounts:", watched());
});
