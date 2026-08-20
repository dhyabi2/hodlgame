# HoldFun Nano (XNO) Layer-2

Proof-of-concept: HoldFun's token economics as a **deterministic layer-2 on Nano**.
No smart contracts — the token ledger is computed by replaying signed Nano data
blocks, and the only real asset (the pool's XNO) sits in threshold custody.

See `../MIGRATION-XNO.md` (proposal) and `./SPEC.md` (encoding + state machine).

## Layout

```
core/       deterministic core (no network, no keys)
  ops.ts        operation types
  state.ts      the state machine: launch (5% cap), transfer, buy/sell (AMM),
                stake/unstake (20% tax = 5% burn + 15% rebate), claim, liquidity
  encoding.ts   op <-> bytes + blake2b-256 commitment (what goes in `link`)
indexer/    reads blocks and folds them into state
  blockSource.ts  BlockSource (MemorySource + NanoRpcSource)
  replay.ts       replay(events) -> state + flagged-invalid
  indexer.ts      Indexer: source -> resolve op -> apply
client/     Nano signing (Ed25519-blake2b via `nanocurrency`)
scripts/    live-smoke: reads a real Nano account via rpc.nano.to
```

## Run

```bash
npm test          # 4 suites, offline, deterministic
npm run live-smoke   # reads real Nano blocks (needs network)
```

## What the tests prove

1. Creator gets **exactly 5%**, structurally (can't even request more).
2. Supply is **locked** — nothing can ever mint (only burn decreases it).
3. Double-spends rejected (transfer/stake beyond balance).
4. Constant-product invariant preserved across swaps (1% fee).
5. Exit tax splits **80/15/5** (user / rebate / burn).
6. Rebates accrue on a **confirmation-height clock** and pay out.
7. Two replays are **byte-identical** (the entire trust model).
8. Ops round-trip through the byte encoding; commitments are stable blake2b-256.
9. Indexer folds real-shaped blocks into state; invalid ops are flagged not thrown.
10. Nano block signing works (Ed25519-blake2b) and signatures verify.
11. `NanoRpcSource` reads real blocks from a live public node.

## Status / remaining (non-spike)

- [x] Deterministic state machine + tests
- [x] Op encoding + commitment
- [x] Replay engine + indexer (mock + live read)
- [x] Nano client signing
- [ ] PoW + block broadcast (send a signed block to a node) — needs a funded account
- [ ] Threshold custody for pool XNO (2-of-3 multi-sig or FROST)
- [ ] Wire the existing Next.js UI onto this client + indexer API
- [ ] Snapshot Solana holders → 1:1 airdrop genesis on Nano
