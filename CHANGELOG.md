# Changelog

All notable changes to HodlGame are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is pre-1.0;
everything lands on `main`.

## [Unreleased]

### Added — 2026-08-30 · Futures Block 3: trade it from the token page
- New **Futures** panel under staking: LONG/SHORT, margin in the token, 1–5×
  leverage; shows the taker-adverse entry (worse of spot/TWAP) and the exact
  liquidation price before you commit (two-click confirm).
- "Shorts waiting / Longs waiting" depth bars — click one to take the other
  side; your resting orders and open positions with live pnl and FIFO-aware
  Close; every open pair listed as a public duel (long wallet vs short wallet).
- `TokenView.futures` (server): spot, TWAP, open interest per side, waiting
  size per side, book and pairs. Explorer labels `open futures` / `close
  futures` ops.

### Added — 2026-08-30 · Futures Block 2: TWAP reference + adverse pricing (manipulation resistance)
- A one-op pump/crash can no longer liquidate anyone or be cashed out: the
  reference is a 10-minute **time**-weighted average of spot (network
  timestamps are already consensus input), takers enter at the worse of
  spot/TWAP, closers settle at the worse for themselves, and liquidation
  requires a breach at **both** spot and TWAP (settling loser-favourably).
  Holding a pump for the window lets everyone else sell into it — the real cost.
- Sampling starts only at a token's first `futOpen`, bounded to 64 samples, so
  no historical root changes (re-verified against the live production root).
- Open-interest cap is now also depth-aware: `≤ 50%` of the token reserve.

### Added — 2026-08-30 · Futures Block 1: token-margined inverse positions (consensus, era-gated)
- New ops `futOpen (0x0c, fragment)` / `futClose (0x0d, compact)`: open a long
  or short on any token with margin posted **in the token itself** — the only
  collateral Nano consensus can enforce (tokens exist only as replay state), so
  the derivative is zero-custody, oracle-free and solvent by construction.
- FIFO matching with partial fills, symmetric close (closer pays 0.5% to the
  party it closes), deterministic liquidation at 5% maintenance on every
  price-moving op, 5× max leverage, 25%-of-supply open-interest cap per side.
- Era-gated (`FUTURES_ERA` 2026-08-30 14:26 UTC) and root-stable: the canonical
  root only gains a `futures` key once a token has activity. Verified
  bit-identical against the **live production root** on the full ledger
  (26 accounts, 1,021 blocks, 21 tokens). Spec §10; `core/futures.test.ts`.

### Changed — 2026-08-25 · Unstake tax: full 20% to stakers, no burn (era-gated)
- From `FULL_REBATE_ERA` (2026-08-25 07:46 UTC) the whole 20% exit tax goes to
  the remaining stakers; nothing is burned. If the last staker leaves, the tax
  is burned instead of stranding in the reward vault (previously 15% could be
  orphaned that way). Unstakes before the boundary keep the legacy 5% burn /
  15% rebate split bit-exact — the state machine now receives the carrier
  block's timestamp purely to pick the era, so history and anchored roots do
  not move. Docs, previews, receipts and the staking explainer updated.

### Fixed — 2026-08-24 · Time-primary canonical order (era cut) — stops retroactive position wipes
- **Root cause** (user reports: a bought position vanished; a
  stake "unstaked itself"): canonical order was Lamport-primary, and Lamport
  clocks cannot order two externally funded wallets against each other (unknown
  funding sources count 0). A fresh exchange-funded wallet's whole chain carried
  near-zero clocks and sorted **before** days-older trades, re-pricing them on
  every replay until their own `minTokens` slippage guards permanently
  invalidated them — erasing bought positions (and any stake funded by them)
  that users had already been shown.
- **Fix**: `canonicalOrder` now sorts `(era, timestamp, lamport, height, hash,
  sub)`. From `TIME_ORDER_ERA` (2026-08-24 ~14:00 UTC) on, the primary key is
  the block's network-observed first-seen time — the order every client's quote
  was actually made against — so newly discovered blocks *append* instead of
  inserting into history. Balance observations inherit their block's timestamp;
  head observations stamp `maxT+1` so they still fold last.
- **Grandfather guarantee**: pre-era history keeps the legacy keys bit-exact
  (timestamps below the cut are ignored), so no currently-served balance moves
  at deploy. A seeded-random property test asserts the new comparator is
  byte-identical to the legacy one on any pre-era event set. (A full-genesis
  time re-sort was evaluated and rejected: prod's served states were never
  consistent with any single order, so re-sorting history redistributes ~24
  currently-visible holder balances.)
- **Explorer consistency**: `replayWithDeltas` now folds in the same fixpoint
  application order as consensus (via a new `fixpointOrder` `onApply` hook), so
  the explorer can no longer flag an op `valid` (+tokens) while feed/holdings
  say the account holds nothing; never-valid ops are flagged with their final
  rejection reason.
- Era-0 losses already baked into served state (invalidated queue-routed buys
  that paid real XNO, erased stakes) are **not** restored by this change —
  restitution is a separate operator decision.

### Added — 2026-08-22 · Direct-Settlement v2 (zero-custody)
- **Zero-custody tokens** (launch opcode `0x0b`, the default in the create form):
  no pool account exists at all. Buys pay queued sellers **wallet-to-wallet**
  (validity-bound to the deposit's destination) or stay in the buyer's own wallet
  as **earmarked collateral at cost**, checked against the signed block balance.
  Sells net prepayments → own earmark (capped by the signed exit-block balance) →
  the remainder (realized appreciation) joins a FIFO queue quoted with a coverage
  haircut and paid directly by future buys. Ratcheting floors + signed-balance
  observations void defected collateral proportionally across tokens. `withdraw`
  is invalid on direct tokens — they settle at sell. Live-verified end-to-end on
  mainnet (queued appreciation paid to the seller's wallet exact to the raw).
- **Virtual liquidity** — a direct token's seed is a fragment-declared price-curve
  setting: no deposit, costs 2 raw. A creator dumping the 5% into fresh virtual
  liquidity receives exactly zero until real buyers commit real collateral.
- **Fragment links extended** — `buy(xno, minTokens)` and `seedLiq/addLiq(xno,
  tokens)` now ride fragment pairs fully on-chain.
- **Lamport causal ordering** — canonical order is now `(lamport, height, hash,
  sub)` with clocks derived from the lattice itself (`lam = 1 + max(prev,
  source-send)`), so cross-account events order by how value actually flowed.
- **Stable fixpoint replay** — ops invalid at their canonical position defer and
  anchor at the earliest point they become valid; appending later events can
  never re-price already-applied history.

### Fixed
- **Regional RPC freeze** — identical Nano RPC POST bodies were served frozen for
  15+ minutes from some regions (edge caching). Every RPC body now carries a
  per-request nonce plus no-cache headers, so no edge cache can key it.

### Changed
- Pooled custody (pool accounts, FROST, the sweep) is now the **legacy lane**,
  scoped to tokens launched with opcode `0x01` before v2.

### Added
- **Pro trading terminal** (`/pro`) — single-token power view: canvas candlestick
  chart with selectable timeframes and volume bars, order ticket with %-of-balance
  quick-fills, live quote (output / min-received / price impact), keyboard hotkeys
  (B/S/Enter), AMM depth curve, live trade tape, holders with top-10 concentration,
  and an inline position card (stake/unstake/claim).
- **Rich token price chart** — Line/Candles toggle, timeframe selector
  (5m–1d), a volume pane, and a crosshair OHLC legend. The chart is now built
  once and only its data updates on the market poll, so zoom/pan survives
  refreshes instead of the chart being torn down every few seconds.
- **Min-clicks UX** — in-place unlock sheet (locked actions no longer bounce to
  the Wallet tab), deep links (`#t=<id>` / `#tab=`), one-tap buy amounts, and a
  remembered 1% default slippage.
- **Shared client trading lib** (`web/app/lib/trade.ts`) — one source of truth for
  on-chain-matching quotes and chain writes, used by the app and the terminal.
- **Wallet: receive + seed backup** — connected wallet now shows a live XNO
  balance, copy-address, auto-receive of pending deposits, and a password-gated
  seed reveal for recovery.
- **Real staking UI** — replaced hardcoded stake/unstake amounts with amount
  inputs, plus a readout of staked balance and claimable XNO rewards
  (`myStaked` / `myClaimable` / `totalStaked` surfaced through the market API;
  new pure `claimableReward()` in `core/state.ts`).
- **Etherscan-style Explorer** — stats dashboard, paginated + filterable op feed,
  op detail with raw-block hexdump + state deltas + confirmations, token/account
  pages, proof-of-reserves, unified search, and **in-browser verification**
  (the browser recomputes the state root from public RPC).
- **Exchange Integration Kit** — deposit derivation, headless idempotent
  two-block withdrawal, read API, and **Merkle per-balance proofs** (O(log N)).
- **FROST 2-of-3 threshold custody** for pool XNO, with pool-key **rotation**
  (current + accepted legacy set) so existing tokens can migrate.
- **Trustless continuity** — chain-derived settlement (the pool's own chain is the
  ledger), on-chain metadata-authority anchors, anchor-account discovery, epoch
  snapshots anchored on-chain, and Shamir k-of-n seed tooling.
- **CI** — 31-suite test job, a **vendored-drift gate** (`nano/*` vs `nano/web/*`),
  and a Next.js build job.
- Repository docs: this changelog, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue/PR templates, and a rewritten README.

### Changed
- **Rewards are now distributed pro-rata by stake** via a bounded `rewardPerShare`
  accumulator — replacing the previous confirmation-height clock, which an account
  could inflate. (READMEs updated to match.)
- **RPC policy** — `rpc.nano.to` primary with `rpc.nano-gpt.com` as the sole
  keyless fallback; layered, validated, fast PoW (cache → rpc → local C → WASM).
- Op payloads moved fully on-chain via **fragment links**; the off-chain commit
  blob is no longer load-bearing.
- Token decimals are pinned in the launch block byte (consensus-bound scale).
- Images stored as `ipfs://CID`, resolved via a gateway-fallback client.

### Fixed
- **Security hardening** — a break-the-validation audit enumerated every gate and
  attacked each with a runnable PoC; 6 confirmed breaks were fixed, including
  RPC-field forgery (deriving amount/subtype/account from the signed chain),
  metadata seq-DoS, non-causal authority fold, rate-limit XFF bypass, fail-open
  sweep, and guardian rubber-stamping. See `docs/SECURITY-AUDIT.md`.

### Migration
- The project moved from **Solana to Nano (XNO)**. The Solana implementation is
  frozen in `archive/solana/`. See `MIGRATION-XNO.md`.
- Added the **Apache-2.0 license** so the project can be legally continued/forked.
