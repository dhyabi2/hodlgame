# HoldFun Nano (XNO) Layer-2

HoldFun's token economics implemented as a **deterministic Layer-2 on Nano**. No
smart contracts — the token ledger is computed by replaying signed Nano data blocks,
and the only real asset (the pool's XNO) sits in **FROST 2-of-3 threshold custody**.

See [`./SPEC.md`](./SPEC.md) (encoding + state machine) and
[`../MIGRATION-XNO.md`](../MIGRATION-XNO.md) (the Solana → Nano proposal). The
top-level [README](../README.md) has the feature overview and architecture diagram.

## Layout

```
core/       deterministic core (no network, no keys) — the trust model
  ops.ts        operation types
  state.ts      state machine: launch (5% cap), transfer, buy/sell (AMM),
                stake/unstake (20% unstake tax = 5% burn + 15% rebate), claim, liquidity
  oplink.ts     compact op <-> 32-byte block link (decimals pinned in the launch byte)
  fraglink.ts   two-amount ops (slippage-protected sell / transfer) across chained blocks
  metaAuth.ts   signed off-chain metadata; metaAnchor.ts anchors authority on-chain
  canonical.ts  canonical event ordering + state root (third-party-verifiable)
  merkle.ts     Merkle balance proofs
  rotate.ts     pool-custody key rotation (current + accepted legacy set)
  blockVerify.ts browser-safe verification primitives
indexer/    reads blocks and folds them into state
  blockSource.ts  BlockSource (MemorySource + NanoRpcSource)
  multiIndexer.ts multi-token replay, value-binding, rotation-aware pool routing
  discovery.ts    anchor-hello discovery (no operator watch-list needed)
server/     market/explorer/exchange APIs, analytics, FROST signer, settlement
client/     Nano Ed25519-blake2b signing + headless idempotent exchange client
lib/        rpc.ts (strict endpoints), layered PoW (cache→rpc→C→WASM), shamir.ts
scripts/    live-smoke, multitoken-e2e, buy-e2e, frost-migrate, shamir-split
web/        Next.js app (vendors core/indexer/server/lib/client — CI drift-gated)
docs/       SECURITY-AUDIT · FROST-CUSTODY · EXPLORER-SPEC · EXCHANGE-KIT · TRUSTLESS-ROADMAP
```

## Run

```bash
npm install
npm test              # 31 suites, offline, deterministic
npm run build-workgen # compile the local PoW helper (tools/workgen.c)
npm run live-smoke    # reads real Nano blocks from a public node (network)
```

## What the tests prove

1. Creator gets **exactly 5%**, structurally (can't even request more).
2. Supply is **locked** — nothing can mint; only the burn decreases it.
3. Double-spends rejected (transfer / stake / unstake beyond balance).
4. Constant-product invariant preserved across swaps (1% fee).
5. Unstake tax splits **80 / 15 / 5** (user / rebate vault / burn).
6. Rebates distribute **pro-rata by stake** via a bounded `rewardPerShare`
   accumulator — independent of the per-account, attacker-inflatable block height.
7. Two replays are **byte-identical**, and the canonical **state root** matches.
8. Ops round-trip through the byte encoding; commitments are stable blake2b-256.
9. The multi-token indexer folds real-shaped blocks; invalid ops are flagged, not thrown.
10. Nano block signing works (Ed25519-blake2b) and signatures verify.
11. `NanoRpcSource` reads real blocks from a live public node.
12. Fragment links, metadata auth, signed comments, Merkle proofs, pool rotation,
    chain-derived settlement, FROST coordination, snapshots, and Shamir splitting
    all round-trip and reconcile.

## Status

- [x] Deterministic state machine + op encoding + commitment
- [x] Multi-token replay engine + indexer (mock + live read) + canonical state root
- [x] Nano client signing + **PoW + block broadcast** (the web app submits signed blocks)
- [x] Slippage-protected trades on-chain (fragment links)
- [x] Signed metadata + on-chain authority anchors; signed comments
- [x] **FROST 2-of-3 threshold custody** for pool XNO + key rotation
- [x] Market/Explorer/Exchange APIs + full Next.js UI (explore · trade · create · scan · wallet · /pro)
- [x] In-browser trustless verification (browser recomputes the state root)
- [x] Merkle balance proofs · epoch snapshots anchored on-chain · Shamir seed splitting
- [ ] Snapshot prior holders → 1:1 airdrop genesis
