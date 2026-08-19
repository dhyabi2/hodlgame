# Mainnet readiness

Status of the blockers identified before a real-money launch, plus the fixes
applied in the HoldFun rebrand.

> **2026-08 session:** the app was rebranded Holder → HoldFun, a hard 5%
> creator cap was added (on-chain), and three further bugs were found and fixed
> by the new test suite:
> 1. `claim_rebate` zeroed `reward_debt` before computing `pending`, so every
>    claim returned `NoRewards` (nobody could ever claim). Fixed + test.
> 2. `initialize` never wrote `stake_vault.bump`, so `stake`/`unstake` failed
>    the seeds constraint. Fixed + test.
> 3. `unstake`'s `mint` account was not writable, so the burn CPI failed with a
>    privilege escalation. Fixed + test.
> The `anchor/tests/holder.ts` suite now covers the full lifecycle.

| # | Blocker | Status |
|---|---|---|
| 1 | Raffle randomness was predictable | ✅ **Closed** — raffle removed entirely |
| 2 | Raffle entrant list was caller-controlled | ✅ **Closed** — raffle removed entirely |
| 3 | No third-party audit; upgrade authority live | ❌ **Open** — requires an external auditor and your keypair |
| 4 | RPC API key shipped in the client bundle | ✅ **Closed** — server-side proxy |
| 5 | Swap pool has no LP accounting | ⚠️ **Contained** — authority-only, must be disclosed |
| 6 | Creator could own 100% of supply | ✅ **Closed** — hard 5% cap in `mint_supply` |

---

## 1 & 2 — Raffle removed

The raffle was not merely weakly random. `draw_raffle` accepted its entrant list
from the caller via `remaining_accounts`, and the winner selection was:

```rust
let rand_val = ... % total_weight;   // ∈ [0, total_weight-1]
let mut acc = 0;
for (weight, ..) in entrants.iter() {
    acc += weight;
    if rand_val < acc { winner = ...; break; }
}
```

With a **one-entrant list**, `acc == total_weight` on the first iteration, so
`rand_val < acc` is unconditionally true. Any staker could call the
permissionless `draw_raffle` passing only their own stake account and win 10% of
the vault, every interval, deterministically. The randomness source was never
even reached.

Rather than rebuild it with a VRF, the whole mechanic was removed:

- **Program:** `initialize_raffle`, `draw_raffle`, `RafflePool`, `RaffleEvent`,
  `InitializeRaffle`, `DrawRaffle`, `RAFFLE_*` constants, `RaffleNotReady`,
  `InvalidRaffleEntrants`, and the `keccak` import.
- **Client:** `RafflePanel`, raffle IDL entries, raffle feed events, the
  `lottery-winner` achievement, raffle chronicle lines, raffle sounds, and the
  raffle odds helper.
- `migrations/init_raffle.ts` deleted.

**Economic effect:** none, other than the vault no longer being skimmed. The 15%
of the exit tax that funds the vault now flows entirely to proportional rebates
via `sync_rewards`, which is where 90% of it already went.

## 4 — RPC key no longer in the client

`NEXT_PUBLIC_RPC_URL` was inlined into the JS bundle by Next, so the Helius API
key was readable by anyone who opened devtools and billable by anyone who copied
it.

- `app/api/rpc/route.ts` proxies JSON-RPC server-side and enforces a
  method allowlist so it can't be used as an open relay.
- The key now lives in `RPC_URL` (server-only, no `NEXT_PUBLIC_` prefix).
- `WalletProvider` points HTTP at `/api/rpc`.

Verified: `grep` for the key across `.next/static/chunks/*.js` returns nothing,
and a `requestAirdrop` call through the proxy returns `403`.

**WebSockets can't be proxied by a route handler.** `NEXT_PUBLIC_WS_URL` is a
separate, keyless endpoint used only for read-only event subscriptions. Set it
to a domain-restricted socket for mainnet — the public cluster WS will not carry
production traffic reliably.

> **Rotate the devnet Helius key.** It was public in the bundle for the life of
> the previous deployment and should be assumed compromised.

## 3 — Audit and upgrade authority (OPEN)

**This cannot be closed by writing code, and nothing above substitutes for it.**

### Audit

The program has never been reviewed by a third party. Budget weeks and
$15k–50k+. Firms that take Solana/Anchor work: OtterSec, Neodyme, Zellic,
Sec3, Halborn.

Prep that makes an audit cheaper and faster — done items marked:

- [x] Write the test suite. `anchor/tests/holder.ts` now covers stake / unstake /
      claim / swap / mint_supply / renounce, including failure paths.
- [ ] Document the intended invariants (e.g. "`total_staked` always equals the
      stake vault's token balance", "`reward_per_point` is monotonic").
- [ ] Fix the arithmetic style: the program uses `.checked_*().unwrap()`
      throughout, which panics rather than returning a program error. Auditors
      will flag every one. Convert to `ok_or(error!(...))?`.
- [x] Review `sync_vault_rewards` — it only advances `last_recorded_balance`
      when `total_points > 0`. This is now *intentional*: rewards that arrive
      while nothing is staked are deferred and distributed to the first stakers
      on the next sync, rather than dropped.
- [x] Review the `claim_rebate` payout clamp — fixed: `pending.min(available)`
      still settles only the paid amount, so an underfunded-vault shortfall is
      carried forward instead of forfeited. The original zeroed `reward_debt`
      before computing `pending`, so no rebate could ever be claimed.
- [x] **Fix the `Initialize` stack overflow.** `initialize` was split so it no
      longer opens two `init` PDAs plus two `init` ATAs in one instruction (the
      token accounts are created client-side and `mint_supply` mints into them).

      (The `spl_token_2022` confidential-transfer warnings in the same build
      output come from a dependency that this program never calls — ignorable.)

### Upgrade authority

Anyone holding it can replace the program and drain every vault. Check it:

```bash
solana program show 9ggxpWrwYXH7sygoqQs2N5qCva38vVkJvr5ZzwPijPUu \
  --url mainnet-beta
```

Then either transfer to a multisig (Squads is the standard):

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT> --url mainnet-beta
```

…or make it immutable, which is irreversible and means no bug can ever be
patched:

```bash
solana program set-upgrade-authority <PROGRAM_ID> --final --url mainnet-beta
```

`vault_state.authority` is a separate key controlling `initialize_pool` and
`add_liquidity`. It should also be a multisig.

## 5 — Swap pool liquidity (CONTAINED, must disclose)

`initialize_pool` and `add_liquidity` are authority-only and there is **no LP
accounting** — no LP mint, no share tracking, no `remove_liquidity`. Deposited
liquidity cannot be withdrawn by anyone, including the authority.

This is safe *because* it's authority-gated: the authority is donating to a pool
it can't withdraw from. It becomes a fund-loss bug the moment `add_liquidity` is
opened to the public, since depositors would receive nothing back.

- **Do not** make `add_liquidity` permissionless without first adding an LP mint,
  proportional share accounting, and `remove_liquidity`.
- **Do** disclose that the pool is seeded and controlled solely by the deployer,
  and that pool depth is at the deployer's discretion.

## Before deploying to mainnet

- [ ] Audit complete, findings remediated
- [x] Test suite covering stake / unstake / claim / swap, including failure paths
- [ ] Upgrade authority → multisig or `--final`
- [ ] `vault_state.authority` → multisig
- [ ] Real mint created on mainnet with a documented supply and distribution
- [ ] `RPC_URL` and `NEXT_PUBLIC_WS_URL` → paid, domain-restricted mainnet endpoints
- [ ] Devnet Helius key rotated
- [ ] `NEXT_PUBLIC_NETWORK=mainnet-beta`, new `NEXT_PUBLIC_MINT` / `NEXT_PUBLIC_PROGRAM_ID`
- [ ] Legal review — a 20% exit tax with a burn is a securities/consumer-protection
      question in several jurisdictions, and this repo gives no opinion on it

## Market indexer (Hot list / 24h change)

The directory's 24h price change and Hot list are served by a Vercel indexer:

- `app/api/cron/snapshot` — cron job (`vercel.json`, `*/10 * * * *`) that snapshots
  every token's price into Vercel KV. Secured by `CRON_SECRET`.
- `app/api/market` — public endpoint returning `change24hPct` per mint, merged
  into the directory client-side.

**One manual step remains:** provision Vercel KV. From the project dashboard run
`vercel integration add upstash` (or Storage → KV → Connect), which auto-sets
`KV_REST_API_URL` and `KV_REST_API_TOKEN`. Until then the app degrades gracefully
(no change %, Hot falls back to most-staked). `CRON_SECRET` is already set.

> Note: Vercel's Hobby plan limits cron to a daily minimum interval; a 10-minute
> snapshot needs Pro. On Hobby the data will simply be fresher-than-daily
> wherever the cron actually runs.

> Note: an empty Blob store (`holdfun-market`, `store_bWstoeH6ID2zvxYh`) was
> created while evaluating storage backends and can be deleted in the dashboard.

## Post-flight (run these in *your* terminal — they need a TTY)

Storage provisioning can't be scripted with an API token (OAuth + term
acceptance). When you're back, run exactly this:

```bash
# 1. Market indexer storage (Vercel KV via Upstash — free tier)
cd app && vercel integration add upstash/upstash-kv     # accept + link to `app`
#    → auto-sets KV_REST_API_URL and KV_REST_API_TOKEN

# 2. Token image storage (Vercel Blob)
vercel blob create-store holdfun-assets --access public   # public: wallets must read it
#    → then in the dashboard: Settings → Storage → Blob → "Create token"
#    → add as BLOB_READ_WRITE_TOKEN

# 3. Redeploy so the routes pick up the new secrets
vercel --prod --yes
```

Non-code blockers (still open): third-party audit, upgrade authority → multisig or
`--final`, `vault_state.authority` → multisig, and legal review of the exit-tax
model. Details below.
