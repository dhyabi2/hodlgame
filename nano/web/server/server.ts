// Operator server (self-host fallback). For Vercel, the sweep runs via the
// cron endpoint /api/cron/sweep (see web/app/api/cron/sweep/route.ts).

import * as http from "node:http";
import type { State } from "../core/state";
import { watched, indexer, runSweep } from "./operator";
import { stateRoot } from "../core/canonical";

const PORT = Number(process.env.PORT ?? 8080);

function mapToObj(m: Map<string, bigint>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of m) o[k] = v.toString();
  return o;
}

function serializeState(s: State, tokenId: string): Record<string, unknown> {
  return {
    tokenId,
    name: s.name,
    symbol: s.symbol,
    decimals: s.decimals,
    image: s.image,
    launched: s.launched,
    supply: s.supply.toString(),
    creator: s.creator,
    creatorShare: s.creatorShare.toString(),
    treasury: s.treasury.toString(),
    rebateVault: s.rebateVault.toString(),
    poolXno: s.poolXno.toString(),
    poolTokens: s.poolTokens.toString(),
    totalStaked: s.totalStaked.toString(),
    rewardPerShare: s.rewardPerShare.toString(),
    height: s.height.toString(),
    balances: mapToObj(s.balances),
    staked: mapToObj(s.staked),
    banked: mapToObj(s.banked),
  };
}

function summary(state: State, tokenId: string): Record<string, unknown> {
  return {
    tokenId,
    name: state.name,
    symbol: state.symbol,
    launched: state.launched,
    supply: state.supply.toString(),
    creator: state.creator,
    creatorShare: state.creatorShare.toString(),
    treasury: state.treasury.toString(),
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
      return json(res, 200, { ok: true, poolSeed: Boolean(process.env.POOL_SEED) });
    }
    if (url.pathname === "/root") {
      // Consensus state root — anyone can recompute it with scripts/verify.ts
      // (no secrets needed) and hold this indexer accountable.
      const idx = await indexer();
      return json(res, 200, { root: stateRoot(idx.getState()), tokens: idx.getState().size });
    }
    if (url.pathname === "/tokens") {
      const idx = await indexer();
      const out = [...idx.getState()].map(([tokenId, s]) => summary(s, tokenId));
      return json(res, 200, out);
    }
    if (url.pathname === "/state") {
      const idx = await indexer();
      const tokenId = url.searchParams.get("token");
      if (!tokenId) {
        return json(res, 200, [...idx.getState()].map(([id, s]) => summary(s, id)));
      }
      const s = idx.getState().get(tokenId);
      return s
        ? json(res, 200, serializeState(s, tokenId))
        : json(res, 404, { error: "unknown token" });
    }
    if (url.pathname === "/balance") {
      const tokenId = url.searchParams.get("token");
      const account = url.searchParams.get("account");
      if (!tokenId || !account) return json(res, 400, { error: "token and account required" });
      const idx = await indexer();
      const s = idx.getState().get(tokenId);
      if (!s) return json(res, 404, { error: "unknown token" });
      return json(res, 200, { tokenId, account, balance: (s.balances.get(account) ?? 0n).toString() });
    }
    if (url.pathname === "/sweep" && req.method === "POST") {
      // Fail CLOSED: an unset OPERATOR_KEY must not open the payout loop.
      const key = process.env.OPERATOR_KEY;
      if (!key || req.headers["x-operator-key"] !== key) {
        return json(res, 403, { error: "unauthorized" });
      }
      return json(res, 200, await runSweep(url.searchParams.get("token")));
    }
    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

function startSweepLoop() {
  const seconds = Number(process.env.SWEEP_SECONDS ?? 30);
  if (!process.env.POOL_SEED) {
    console.log("sweep loop disabled (no POOL_SEED)");
    return;
  }
  const tick = async () => {
    try {
      const r = await runSweep(null);
      if (r.received?.length || r.paid?.length || r.refunds?.length) {
        console.log("sweep:", JSON.stringify(r));
      }
    } catch (e: any) {
      console.log("sweep error:", e?.message ?? e);
    }
  };
  setInterval(tick, seconds * 1000);
  tick();
}

server.listen(PORT, () => {
  console.log(`HoldFun multi-token operator listening on :${PORT}`);
  console.log("watched accounts:", watched());
  startSweepLoop();
});