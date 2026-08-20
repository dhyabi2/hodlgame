# Deploying HoldFun to Vercel

The whole L2 can run on Vercel because every op is on the public Nano ledger and
state is deterministically replayable. No always-on server is needed.

## Topology (2-of-3, no single custody)

1. **Main project** — web UI + read API + cron sweep + comments/metadata.
   Holds `POOL_SEED` (operator key) + `NANO_RPC_KEY`.
2. **Guardian projects** (2) — the `/api/guardian/sign` route, each with its own
   `GUARDIAN_SEED`. Each holds **1 of 3** keys, so no single deployment holds a
   quorum.

## Vercel project settings

- **Root Directory**: `nano/web`
- **Framework**: Next.js
- **Build**: default (`next build`)

### Shared code (symlinks)

`web/core`, `web/server`, `web/indexer`, `web/lib`, `web/client` are symlinks to
`../…` (siblings of `nano/web`). Vercel only ships files inside the Root
Directory, so pick one:

- **(Recommended) Deploy from the repo root**: set **Root Directory = `.`** and
  `buildCommand`/`outputDirectory` via `vercel.json` at the repo root, i.e. treat
  the repo as a monorepo. Then the symlinked siblings are inside the deploy root.
- **Or vendor** the shared dirs (`cp -r ../core ../server ../indexer ../lib ../client .`)
  and remove the symlinks before committing changes.

## Environment variables

**Main project**

| var | value |
|---|---|
| `STORE` | `upstash` |
| `UPSTASH_REDIS_REST_URL` | from **Upstash Redis** (REST) |
| `UPSTASH_REDIS_REST_TOKEN` | from **Upstash Redis** (REST) |
| `NANO_RPC_KEY` | rpc.nano.to API key |
| `POOL_SEED` | 64-hex operator master seed (pool key derivation only) |
| `WATCHED_ACCOUNTS` | comma-separated Nano accounts the indexer watches |
| `CRON_SECRET` | any random string (guards `/api/cron/sweep`) |
| `GUARDIAN_URLS` | `https://<g1>.vercel.app/api/guardian/sign,https://<g2>.vercel.app/api/guardian/sign` |
| `GUARDIAN_KEYS` | `g1Key,g2Key` (must match each guardian's `GUARDIAN_KEY`) |
| `PINATA_JWT` | optional fallback |

**Each guardian project**

| var | value |
|---|---|
| `GUARDIAN_SEED` | independent 64-hex key (NOT derived from the master) |
| `GUARDIAN_KEY` | shared secret matching the operator's `GUARDIAN_KEYS` |
| `GUARDED_POOLS` | comma-separated `nano_…` pool accounts it co-guards |
| `STORE` | `upstash` (durable nonce/replay protection) |

## Storage

Each record is stored under a `holdfun:<name>` key in **Vercel KV** (Upstash),
BigInt-safe via `core/json`. No schema needed.

## Cron

The sweep runs every minute via `/api/cron/sweep` (`vercel.json`). On the Vercel
**Hobby** plan crons are limited — use **Pro** for a live trading engine.

## What cannot run here

Nothing material. The old `npm run operator` / `npm run guardian` processes remain
for self-host fallback, but on Vercel their work is done by `/api/cron/sweep` and
`/api/guardian/sign`.

## Still a code TODO (independent of deploy target)

The **on-chain 2-of-3 multisig conversion** of pool accounts (setting their
`representative` to the multisig definition) is not implemented. Until it is
added and tested with dust, the pool accounts are effectively single-key even
though guardians co-sign.