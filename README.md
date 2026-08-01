# Holder — Solana Game

A devnet MVP of the Holder game: stake tokens, pay a 20% tax on unstake (5% burned forever, 15% funds the rebate vault), and earn rebates proportional to your stake × time. Also includes an on-chain SOL⇄HOLD swap pool.

Live: https://app-theta-eight-74.vercel.app

## Architecture

- **Chain:** Solana devnet
- **Program:** Anchor/Rust (`anchor/programs/holder`)
- **Frontend:** Next.js 14 + Tailwind + Solana wallet adapters (`app`)

## Important deviation from the v2 design doc

This MVP uses a **program-enforced 20% tax on unstake** instead of Token-2022's global transfer-fee extension. The reason is practical: Token-2022 cannot exempt staking deposits from the fee, so every deposit would also be taxed 20%. The program still enforces the tax trustlessly (no operator custody), and the same stake×time rebate engine runs on-chain.

## Project layout

```
anchor/          # Anchor workspace
  programs/holder/src/lib.rs   # on-chain program
  migrations/deploy.ts         # deploy + mint script
  Anchor.toml
app/             # Next.js frontend
  app/           # pages
  components/    # UI
  lib/           # IDL, helpers
```

## Quick start

```bash
# 1. Install deps
cd app && npm install

# 2. Build program
cd ../anchor
anchor build

# 3. Deploy + initialize
cd ../anchor
anchor deploy
anchor run migrate

# 4. Run frontend
cd ../app
npm run dev
```

## Program instructions

- `initialize` — create vault, stake vault, and token accounts.
- `stake(amount)` — deposit tokens into the stake vault, no tax.
- `unstake(amount)` — withdraw tokens; 20% tax on exit (5% of the amount burned forever, 15% to the rebate vault), 80% to user.
- `claim_rebate()` — claim accrued rebates from the vault.
- `sync_rewards()` — permissionless crank to distribute new vault inflows.
- `initialize_pool(sol_amount, hold_amount)` — authority-only, seeds the SOL/HOLD swap pool.
- `add_liquidity(sol_amount, hold_amount)` — authority-only, tops up pool liquidity anytime (no redeploy needed — see `anchor/migrations/add_liquidity.ts`).
- `swap_sol_for_hold(sol_in, min_hold_out)` / `swap_hold_for_sol(hold_in, min_sol_out)` — anyone, constant-product swap with a 1% fee retained in the pool.

## Risks & next steps

- No wrapper/DeFi composability yet.
- No anti-sybil or referral loop yet.
- Token mint is created fresh on each deploy; update `app/.env.local` after deploy.
- Devnet only — do not deploy to mainnet without an audit and a real liquidity plan.
