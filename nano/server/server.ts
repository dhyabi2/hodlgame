// Operator server: multi-token indexer + per-token custody behind a minimal HTTP API.
//
//   NANO_RPC_KEY=... POOL_SEED=<64B hex master seed> WATCHED_ACCOUNTS=comma,sep \
//   npm run operator
//
// Endpoints:
//   GET  /health                 liveness
//   GET  /tokens                 all tokens (summary)
//   GET  /state?token=<id>       one token's full state (omit token → summaries)
//   GET  /balance?token=<id>&account=<nano_…>   a user's token balance
//   POST /sweep?token=<id>       receive buys + pay sells (omit token → all)

import * as http from "node:http";
import { MultiIndexer } from "../indexer/multiIndexer";
import { NanoRpcSource } from "../indexer/blockSource";
import type { State } from "../core/state";
import { tokenPoolKeys } from "./custody";
import { receivePoolsMulti, payoutSellsMulti, readPoolDeposits, refundRejectedBuys } from "./sweep";
import { creditedBuys, computeRefunds } from "./reconcile";
import { commitResolver } from "./commits";
import { loadNanoRpcKey } from "../lib/rpc";

const PORT = Number(process.env.PORT ?? 8080);

function watched(): string[] {
  const raw = process.env.WATCHED_ACCOUNTS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function indexer(): Promise<MultiIndexer> {
  const idx = new MultiIndexer(new NanoRpcSource(loadNanoRpcKey()), () => ({ name: "", symbol: "", decimals: 6, image: "" }), commitResolver());
  await idx.sync(watched());
  return idx;
}

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
    totalPoints: s.totalPoints.toString(),
    rewardPerPoint: s.rewardPerPoint.toString(),
    height: s.height.toString(),
    balances: mapToObj(s.balances),
    staked: mapToObj(s.staked),
    points: mapToObj(s.points),
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
      return json(res, 200, await runSweep(url.searchParams.get("token")));
    }
    return json(res, 404, { error: "not found" });
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

async function runSweep(onlyToken: string | null) {
  const masterSeed = process.env.POOL_SEED;
  if (!masterSeed) return { error: "POOL_SEED not set" };
  const key = loadNanoRpcKey();
  const idx = await indexer();
  const events = await idx.collectEvents(watched());
  const credits = creditedBuys(events);
  const sells = events
    .filter((e) => e.op.kind === "sell")
    .map((e) => ({
      tokenId: e.tokenId,
      sender: e.sender,
      tokens: e.op.kind === "sell" ? e.op.tokens : 0n,
      minXno: e.op.kind === "sell" ? e.op.minXno : 0n,
      hash: e.hash,
    }));

  const known = [...idx.getState().keys()];
  const targets = onlyToken ? (known.includes(onlyToken) ? [onlyToken] : []) : known;

  const received = await receivePoolsMulti(key, masterSeed, targets);

  const filterFor = (s: typeof sells[number]) => !onlyToken || s.tokenId === onlyToken;
  const { paid, skipped } = await payoutSellsMulti(key, masterSeed, idx.getState(), sells.filter(filterFor), []);

  const refunds: string[] = [];
  for (const tokenId of targets) {
    const pool = tokenPoolKeys(masterSeed, tokenId);
    const poolReceived = await readPoolDeposits(key, pool);
    const owed = computeRefunds(poolReceived, credits.get(tokenId) ?? new Map());
    refunds.push(...(await refundRejectedBuys(key, pool, owed)));
  }

  return { received, paid, skipped, refunds };
}

/** Background loop: sweep every SWEEP_SECONDS (default 30s). */
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