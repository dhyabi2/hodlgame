# HoldFun Exchange Integration Kit

Everything an exchange needs to list a HoldFun token. The one fact that shapes
it all: **a HoldFun token is not a native Nano asset** — its balances live in
an off-chain deterministic ledger computed by replaying Nano blocks. So an
exchange doesn't query a chain balance; it **verifies the state root** and
reads the balance from a replay it can reproduce. That verifiability is the
selling point: an exchange can *prove* customer balances from public data,
which a normal token contract can't offer.

## 1. Verify, don't trust (proof of reserves)

- Every token balance is authenticated by the consensus **state root**
  (`core/canonical.ts`), served at `GET /root` and returned with each balance.
- `npx tsx scripts/verify.ts` (or the Docker image below) recomputes the entire
  market from public Nano blocks **with zero secrets** and prints the root.
  Match it against `/root` → the served balances are proven, not trusted.
- Pool XNO reserves are separately auditable: the trust dashboard
  (`/api/explorer?view=trust`) shows indexed pool XNO vs the live on-chain
  pool balance vs outstanding obligations.
- Snapshots of residual off-chain data are hash-anchored on-chain
  (`server/snapshot.ts`) — mirror-and-verify.

**Docker verifying indexer** (run it yourself, trust nothing):
```dockerfile
# nano/ as build context
FROM node:22-slim
WORKDIR /app
COPY package*.json ./ && RUN npm ci
COPY . .
ENV WATCHED_ACCOUNTS="" NANO_RPC_KEY=""
CMD ["npx","tsx","scripts/verify.ts"]
```
Point `NANO_RPC_KEY` at your rpc.nano.to key; it replays and prints/compares
the root. (A hosted read API also exists — see §4 — but self-hosting is the
zero-trust path.)

## 2. Deposits — per-customer accounts (your key, your derivation)

Every user is a bare `nano_` keypair; a token `transfer` credits the recipient
account in the replayed ledger. Give each customer a **deterministic deposit
account** derived from YOUR master seed (HoldFun never sees it):

```ts
import { depositAddress } from "server/exchange";
const addr = depositAddress(exchangeMasterSeed /* 64 hex */, customerId);
// seed = blake2b(master ‖ "holdfun-deposit\0" ‖ customerId) — domain-separated,
// length-validated (no boundary ambiguity), one account per customer.
```

Credit the customer when a token transfer to `addr` appears and its **frag-B
block is cemented** (`block_info.confirmed`). Fund each deposit account with a
dust of XNO once so it can later be swept, and let it auto-hello for discovery
(or watch it directly).

## 3. Withdrawals — headless, crash-safe, idempotent

A transfer is two chained 1-raw blocks (fragment links). Drive them from your
server with your own key:

```ts
import { withdrawToken } from "client/exchangeWithdraw";
let st = await withdrawToken(exchangeSeed, { id, tokenId, to, amount }, rpc);
persist(st);                      // outbox row
// on restart: withdrawToken(exchangeSeed, req, rpc, loadedState)
```

Safety: Nano block hashes are deterministic, so re-broadcasting is a **no-op**
(no double-send); a dangling frag A is deterministically **ignored** (no
partial credit), so a crash between A and B cannot half-transfer — you just
complete B. Mark the customer paid only after `withdrawConfirmed(rpc, st)`.

## 4. Token identity, decimals, price (`GET /api/exchange`)

- `?view=token-info&q=<tokenId>` → `{ symbol, name, decimals, supply, creator,
  metadataAuthority, metadataImmutable, priceRaw, poolAddress }`.
- `?view=balance&token=<id>&account=<nano_>` → `{ balanceRaw, decimals,
  stateRoot }` (the root proves the balance).

**Key everything on `tokenId`** (128-bit launch-hash prefix, unforgeable) —
symbols can collide. **Decimals are consensus-bound**: they live in the launch
op link (byte 1 = decimals+1), part of the launch block, immutable. Verify
independently by decoding the token's launch block link
(`GET /api/explorer?view=op&q=<launchHash>`) — byte 1 minus 1 is the decimals.
This closes the classic footgun of a mutable off-chain decimals value.

## 5. Finality

Nano cemented blocks never reorg. Treat a deposit/withdrawal as final when its
completing block's `block_info.confirmed === "true"`. The indexer replay counts
pending sends for liveness, so gate customer credit on cementation, not on the
indexer balance alone.

## What exists vs what you build

| Piece | Status |
|---|---|
| Proof-of-reserves (root + verify + trust dashboard + snapshots) | **Exists** |
| Immutable, consensus-bound decimals | **Exists** (launch-link byte 1) |
| Deposit-account derivation | **Exists** (`server/exchange.ts`) |
| Headless idempotent withdrawal | **Exists** (`client/exchangeWithdraw.ts`) |
| token-info / balance read API | **Exists** (`/api/exchange`) |
| Docker verifying indexer | recipe above (package as needed) |
| Per-balance Merkle proofs (light verify without full replay) | **Exists** (`core/merkle.ts`, `/api/exchange?view=balance-proof`) |

## 6. Light balance verification (Merkle proofs)

For a busy exchange that doesn't want to replay for every balance check:
`GET /api/exchange?view=balance-proof&token=<id>&account=<nano_>` returns
`{ balanceRaw, balanceRoot, proof, stateRoot }`. Establish the `balanceRoot`
once (recompute it from a periodic full verify, or trust its on-chain anchor),
then verify each customer's balance in O(log N) with no replay:

```ts
import { verifyMerkleProof } from "core/merkle";
// proof.leaf is `${tokenId}|${account}|${balanceRaw}` — check it matches your
// request, then:
if (verifyMerkleProof(proof) && proof.root === trustedBalanceRoot) creditVerified();
```

The `balanceRoot` is a pure function of the same ledger the `stateRoot`
commits to, so anyone who replays confirms both — light clients get succinct
proofs, full clients get end-to-end verification.
