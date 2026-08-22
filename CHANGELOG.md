# Changelog

All notable changes to HodlGame are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is pre-1.0;
everything lands on `main`.

## [Unreleased]

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
