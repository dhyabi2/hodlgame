# HoldFun — Solana implementation (ARCHIVED)

This directory is the **frozen, archived** Solana version of HoldFun. It is kept
for reference and rollback only — the active project is now the Nano (XNO)
layer-2 in [`../../nano`](../../nano).

## What's here

```
anchor/   the Anchor/Rust program (5% cap, treasury, mint_supply/renounce,
          stake/unstake rebates, constant-product swap, add_liquidity)
app/      the Next.js frontend (pump.fun-style UI, buy/sell, liquidity, chart,
          IPFS images, market lists)
MAINNET.md  Solana mainnet-readiness checklist
```

The Solana program is deployed on **devnet** at
`9ggxpWrwYXH7sygoqQs2N5qCva38vVkJvr5ZzwPijPUu`; the app was live at
`app-theta-eight-74.vercel.app`. Nothing here is maintained.

To resume the Solana work: `git log -- archive/solana` and restore as needed.
