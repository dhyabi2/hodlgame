# HoldFun — Solana Game

A devnet MVP of HoldFun: the pump.fun model, rebuilt around holding. Every
token enforces that its creator can never own more than **5%** of the supply —
the community's 95% funds the trading pool — and a 20% tax on unstake (5%
burned forever, 15% funds the rebate vault) pays the people who actually hold.

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
./build.sh          # wrapper for `anchor build` — see note below

# 3. Deploy + initialize
cd ../anchor
anchor deploy
anchor run migrate

# 4. Run frontend
cd ../app
npm run dev
```

## Program instructions

- `initialize` — create the vault state and stake vault PDAs.
- `mint_supply(total_supply)` — one-time: mints 5% to the creator, 95% to the community treasury. The mint authority is a program PDA, so this is the *only* way supply moves.
- `renounce` — irreversibly destroys the mint authority.
- `stake(amount)` — deposit tokens into the stake vault, no tax.
- `unstake(amount)` — withdraw tokens; 20% tax on exit (5% of the amount burned forever, 15% to the rebate vault), 80% to user.
- `claim_rebate()` — claim accrued rebates from the vault.
- `sync_rewards()` — permissionless crank to distribute new vault inflows.
- `initialize_pool(sol_amount, hold_amount)` — authority-only; SOL from the authority, tokens from the community treasury.
- `add_liquidity(sol_amount, hold_amount)` — authority-only; tops up the pool from the treasury.
- `swap_sol_for_hold(sol_in, min_hold_out)` / `swap_hold_for_sol(hold_in, min_sol_out)` — anyone, constant-product swap with a 1% fee retained in the pool.

## Tests

```bash
cd anchor && anchor test --provider.cluster localnet
```

The suite (`anchor/tests/holder.ts`) covers the full launch lifecycle and the
core economics: the 5%/95% split, one-time `mint_supply`, `renounce`, the
stake → unstake tax (5% burn / 15% rebate / 80% user), `claim_rebate`, both
swaps, and the failure paths. See `anchor/build.sh` for the toolchain shims
`anchor test` needs (the same `build-bpf` → `build-sbf` workaround applies).

## Risks & next steps

- No third-party audit yet — required before any real-money launch.
- No wrapper/DeFi composability yet.
- No anti-sybil or referral loop yet.
- Token mint is created fresh on each deploy; update `app/.env.local` after deploy.
- Devnet only — do not deploy to mainnet without an audit and a real liquidity plan.

## Building the program

Use `anchor/build.sh` rather than `anchor build` directly. Anchor 0.29 with
Agave 3.x and a modern rustup hits two toolchain incompatibilities — a tab/space
parsing bug in `cargo-build-sbf`, and the `build-bpf` → `build-sbf` rename. The
script shims both for the duration of the build and changes nothing globally.
See the comments at the top of the script for details.

## Launching your own token

The on-chain program is multi-tenant: every PDA is seeded by mint
(`[b"vault_state", mint]`, `[b"stake_vault", mint]`, `[b"swap_pool", mint]`) and
`initialize` takes an unconstrained `authority: Signer`. One deployed program
therefore serves every token anyone creates, and whoever calls `initialize` for
a mint becomes that game's authority.

The `/create` wizard orchestrates the whole launch client-side, in seven
transactions signed by the creator's wallet:

1. `create_account` + `initialize_mint2` — a new SPL mint whose **mint authority
   is the program PDA** (never the creator), with no freeze authority
2. Token Metadata `CreateMetadataAccountV3` — name and symbol
3. Create the four token accounts (creator, vault, staking, community treasury)
4. `initialize` — the stake vault and rebate vault
5. `mint_supply` — mints the supply: **5% to the creator, 95% to the treasury**
6. `initialize_pool` — creator SOL + the community's 95% open the pool
7. `renounce` — the mint authority is destroyed forever

Progress is checkpointed to localStorage, so a rejected or failed transaction
resumes from that step rather than stranding a half-created token.

The 5% cap is not a UI promise — it is enforced in the program. The creator
never holds the mint authority, `mint_supply` runs once and allocates at most
`MAX_CREATOR_SHARE_BPS` (500 = 5%) to the creator, and `renounce` removes the
mint authority entirely. There is no code path to more than 5%.

Routes:

- `/` — directory of every launched game, with risk flags
- `/create` — the launch wizard
- `/t/<mint>` — the game for one token
