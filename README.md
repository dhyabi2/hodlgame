# HoldFun — Nano (XNO) Layer-2

HoldFun: the token launchpad where **the creator can never own more than 5%**, and
**holding is the game** — 95% of every token goes to the community, a 20% exit tax
burns 5% and pays the rest to the people who hold.

This is now a **Nano (XNO) layer-2**. Nano has no smart contracts, so the token
ledger is computed **deterministically** by replaying signed Nano data blocks, and
the only real asset (the pool's XNO) sits in threshold custody. No gas, sub-second
finality, and a keyless token ledger that no one can rug.

The previous Solana implementation is preserved in [`archive/solana/`](archive/solana/README.md).

## Repo layout

```
nano/            the active project
  core/          deterministic token ledger + op encoding (the trust model)
  indexer/       reads Nano blocks and folds them into state
  client/        Nano Ed25519-blake2b signing
  scripts/       live smoke test against a public Nano node
  SPEC.md        encoding + state-machine spec
  README.md      details + status
archive/solana/  the old Solana program + Next.js app (frozen)
MIGRATION-XNO.md the full migration proposal
```

## Quick start

```bash
cd nano
npm install
npm test            # 4 offline-deterministic suites
npm run live-smoke  # reads real Nano blocks (network)
```

## The rules (enforced deterministically, not by a contract)

1. **5% cap** — the creator's share is `floor(supply × 5%)`, structurally; no one
   can specify their own.
2. **Supply locked** — nothing can ever mint after launch; only the exit tax's 5%
   burn decreases it.
3. **Trading** — constant-product AMM (XNO ⇄ token), 1% fee retained in the pool.
4. **Holding pays** — 20% exit tax: 5% burned, 15% to the rebate vault, paid to
   stakers by `stake × height` (confirmation height is the clock).

See `nano/SPEC.md` and `MIGRATION-XNO.md` for the full design.
