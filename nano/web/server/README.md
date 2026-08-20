# Operator — indexer + custody (v1)

A single deployable unit: replays Nano blocks into HoldFun's deterministic token
state, and (for sells) signs XNO payouts from the pool.

## Run

```bash
cd nano
npm install
NANO_RPC_KEY=RPC-KEY-... \
POOL_SEED=<32-byte hex> \
TOKEN_NAME="HoldFun" TOKEN_SYMBOL="HOLD" \
WATCHED_ACCOUNTS=<comma,sep,nano_,accounts> \
npm run operator
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | liveness + pool address |
| `GET /state` | replayed token state (supply, creator share, pool, staked, rebate) |
| `GET /balance/:account` | a user's token balance |
| `POST /sweep` | detect sells → payout (v1: stub; custody sign path is ready) |

## Model (v1)

- **Ops** are compact 32-byte payloads carried in a Nano block's `link` (a
  "send" block, balance −1 raw). See `core/compact.ts`.
- **Pool** is a single-key Nano account (`POOL_SEED`) holding XNO.
- **Indexer** replays watched accounts → `core/state.ts` state machine.
- **Custody** signs pool→user payouts; `signPayout` already accepts extra
  cosigner seeds (2-of-3 multisig) — wire `cosignerSeeds` to upgrade.

## Expand later

- 2-of-3 multisig: pass 3 seeds, submit `signatures` array (path exists in
  `custody.ts`).
- Move custody to a dedicated VPS; keep the indexer on Vercel.
- Multi-token: per-token pools + a token-id in the op.
- Buy auto-credit: sweep the pool account's incoming XNO through the AMM.
