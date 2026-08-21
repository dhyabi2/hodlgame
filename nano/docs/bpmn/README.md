# HoldFun on Nano — BPMN 2.0 process models

This folder contains **BPMN 2.0** models (`.bpmn` = XML) of every flow in the
HoldFun Nano layer-2, documenting **how the whole thing works without smart
contracts**.

## The core idea (read first)

Nano (XNO) has **no smart contracts**. HoldFun substitutes three primitives that,
together, reproduce a token ledger *deterministically*:

1. **The token ledger is a pure function of signed data.** Every action is a
   signed Nano state block; the ledger is computed by *replaying* those blocks.
   Two indexers replaying the same blocks must produce **byte-identical** state.
   → trust = determinism, not a VM.

2. **The only real asset (XNO) sits in threshold custody.** The pool account is a
   2-of-3 multisig (operator key + 2 independent guardian keys). Sells are paid
   out only when 2 of 3 co-sign.

3. **Value is bound on-chain, intent is committed on-chain.** A `buy` is *two
   chained blocks*: a native XNO send (the value) + a data block whose `previous`
   points to that send (the intent). The indexer reads the native amount as the
   authoritative `xno` — the buyer can neither under- nor over-declare.

## File index

| File | Flow |
|---|---|
| `00-overview.bpmn` | Collaboration overview — all actors, all message flows |
| `01-launch.bpmn` | Creator launches a token (5% cap is structural) |
| `02-buy.bpmn` | Value-bound buy (deposit → chained buy op → credit) |
| `03-sell.bpmn` | Sell → exact XNO-out → 2-of-3 custody payout |
| `04-staking.bpmn` | Stake / unstake (20% tax) / claim rebates |
| `05-indexer-replay.bpmn` | Read blocks → decode → fold → flag invalid |
| `06-custody-multisig.bpmn` | 2-of-3 multisig co-signing (guardian re-verification) |
| `07-refund-reconcile.bpmn` | Rejected-buy refund (received − credited) |
| `08-commit-reveal.bpmn` | Commit-reveal for ops that don't fit the 32-byte link |

## Key techniques (map to code)

| Technique | Where | Purpose |
|---|---|---|
| **Deterministic replay** | `core/state.ts` `applyOp`/`applyOps`, `core/multi.ts` `applyBlock` | ledger = pure fold; no VM |
| **Op encoding in `link`** | `core/oplink.ts` `encodeOpLink` | `[opcode 1B][tokenId 16B][amount 15B]` |
| **Commit-reveal** | `core/commit.ts` `commitLink`, `server/commits.ts` | `0xFF ‖ blake2b(tokenId‖op)` for 2-amount/string ops |
| **Value-bound buy** | `indexer/multiIndexer.ts` `collectEvents` | `xno` read from the chained deposit's native amount |
| **tokenId = launch-hash prefix** | `core/token.ts` `tokenIdFromLaunchHash` | identity without a registry |
| **Constant-product AMM + fees** | `core/state.ts` `constantProductOut` | 1% swap fee retained; exit tax 20% |
| **Height clock** | `core/state.ts` `accrue`/`settlePoints`/`syncRewards` | rewards by confirmation height, timestamp-free |
| **2-of-3 threshold custody** | `server/custody.ts` `signPayoutWithSignatures`, `server/guardian.ts` | payouts need 2 of 3 keys |
| **Idempotent sweep** | `server/sweep.ts` + `server/store.ts` | `paid` set prevents double-pay |
| **Refund reconciliation** | `server/reconcile.ts` `creditedBuys`/`computeRefunds` | refund = received − credited |

## How to open

- [bpmn.io modeler](https://bpmn.io/toolkit/bpmn-js/) or
  [Camunda Modeler](https://camunda.com/download/modeler/) — open any `.bpmn`.
- VSCode + "BPMN Editor" extension.

`serviceTask` names are the **actual function names** from the code, so the model
maps 1:1 to `nano/core/`, `nano/indexer/`, and `nano/server/`.
