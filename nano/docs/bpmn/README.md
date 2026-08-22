# HodlGame on Nano — BPMN 2.0 process models

> **Scope note (Direct-Settlement v2, 2026-08-22):** diagrams involving the pool
> account / custody / sweep describe the **legacy pooled lane** (opcode `0x01`).
> v2 zero-custody tokens (opcode `0x0b`) settle wallet-to-wallet with no pool —
> see `../../SPEC.md` §8.


This folder contains **BPMN 2.0** models (`.bpmn` = XML) of every flow in the
HodlGame Nano layer-2, documenting **how the whole thing works without smart
contracts** — and, since the trustless-continuity work
(`docs/TRUSTLESS-ROADMAP.md`), **without any private inputs**: every flow
below is a pure function of public chain data.

## The core idea (read first)

Nano (XNO) has **no smart contracts**. HodlGame substitutes four primitives
that, together, reproduce a token ledger *deterministically*:

1. **The token ledger is a pure function of signed data.** Every action is a
   signed Nano state block; the ledger is computed by *replaying* those blocks.
   Two indexers replaying the same blocks must produce **byte-identical** state
   (a blake2b state root makes this checkable). → trust = determinism, not a VM.

2. **Value is bound on-chain, payloads live on-chain.** A `buy` or a liquidity
   seed is *two chained blocks*: a native XNO send (the value) + a data block
   whose `previous` points to that send (the intent). The indexer reads the
   native amount as the authoritative `xno` — declared amounts are dead
   weight. Ops too large for one 32-byte link (`transfer`, `sell` with
   `minXno`) ride **fragment links**: two chained data blocks that carry the
   full payload, so replay needs *no off-chain registry*.

3. **Everything else is anchored on-chain too.** Participants self-register
   with a 1-raw *hello* to a public anchor account (discovery needs no
   operator list); pools self-register with their tokenId in the hello's
   representative; metadata freezes/transfers are 1-raw anchor burns; epoch
   snapshots of residual off-chain data are hash-anchored.

4. **Settlement re-derives from the pool's own chain.** Payouts and refunds
   net per recipient — `pay max(0, entitlement − alreadySent)` — where
   `alreadySent` is read from the pool account's outgoing sends. No private
   ledgers; N concurrent sweepers converge on identical blocks. Custody of
   the pool keys is the one remaining trust point (single-key today; the
   roadmap lifts a production blake2b-FROST 2-of-3 — see `06-custody.bpmn`).

## File index

| File | Flow |
|---|---|
| `00-overview.bpmn` | End-to-end overview — all lanes, chain-only data flow |
| `01-launch.bpmn` | Hello → launch → signed metadata publish |
| `02-buy.bpmn` | Value-bound buy (deposit → chained buy op → credit) |
| `03-sell.bpmn` | Compact / fragment sell → netted chain-derived payout |
| `04-staking.bpmn` | Stake / unstake (20% tax) / claim rebates |
| `05-indexer-replay.bpmn` | Verified fetch → decode (fragments/anchors) → two-pass pools → fold → root |
| `06-custody.bpmn` | Custody today (single-key, policy guardian) + FROST roadmap |
| `07-settlement.bpmn` | Chain-derived netted settlement (sells + refunds, no ledgers) |
| `08-fragment-links.bpmn` | Fragment links: full op payload on-chain (replaces commit-reveal) |
| `09-metadata-authority.bpmn` | Signed metadata updates + on-chain authority anchors |
| `10-discovery.bpmn` | Anchor hellos → 2-hop participant discovery |
| `11-verify.bpmn` | Secretless verification: replay → state root → compare; snapshots |
| `holdfun-all.bpmn` | All processes merged (regenerate with `node build-all.mjs`) |

## Key techniques (map to code)

| Technique | Where | Purpose |
|---|---|---|
| **Deterministic replay** | `core/state.ts` `applyOp`, `core/multi.ts` `applyBlock`, `indexer/replay.ts` | ledger = pure fold; no VM |
| **Op encoding in `link`** | `core/oplink.ts` `encodeOpLink` | `[opcode 1B][tokenId 16B][amount 15B]` |
| **Fragment links** | `core/fraglink.ts`, `indexer/multiIndexer.ts` `decodeChain` | 2-amount ops fully on-chain (2 chained blocks, `0xE` marker) |
| **Value-bound buy/seed** | `indexer/multiIndexer.ts` `collectEvents` | `xno` read from the chained deposit's native amount |
| **Chain-derived pools** | `indexer/multiIndexer.ts` `derivePoolKeysFromChain` | pool pubkey = first creator seed deposit's link; no secret needed to verify |
| **tokenId = launch-hash prefix** | `core/token.ts` `tokenIdFromLaunchHash` | identity without a registry |
| **Anchor discovery** | `core/anchor.ts`, `indexer/discovery.ts` | participants from chain data; no watch list |
| **Signed metadata / comments** | `core/metaAuth.ts`, `core/commentAuth.ts` | domain-separated ed25519-blake2b signatures |
| **Authority anchors** | `core/metaAnchor.ts` | freeze/transfer as 1-raw burns; authority = fold over chain |
| **Netted settlement** | `server/settled.ts`, `server/sweep.ts` `settlePoolNetted` | pay entitlement − alreadySent; exactly-once without a database |
| **Verified RPC** | `lib/rpc.ts` (failover), `indexer/blockSource.ts` `verifyFetchedBlock` | untrusted endpoints can omit, never forge |
| **State root + verify** | `core/canonical.ts` `stateRoot`, `scripts/verify.ts` | anyone recomputes the market with zero secrets |
| **Snapshot anchoring** | `server/snapshot.ts` | residual off-chain data hash-anchored on-chain |
| **Constant-product AMM + fees** | `core/state.ts` `constantProductOut` | 1% swap fee retained; exit tax 20% |
| **Height clock** | `core/state.ts` `settle`/`syncRewards` | rewards by confirmation height, timestamp-free |

## How to open

- [bpmn.io modeler](https://bpmn.io/toolkit/bpmn-js/) or
  [Camunda Modeler](https://camunda.com/download/modeler/) — open any `.bpmn`.
- VSCode + "BPMN Editor" extension.
- Regenerate the merged file: `node build-all.mjs` (in this folder).

`serviceTask` names are the **actual function names** from the code, so the
model maps 1:1 to `nano/core/`, `nano/indexer/`, and `nano/server/`.
