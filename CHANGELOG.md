# Changelog

All notable changes to HoldFun are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is pre-1.0;
everything lands on `main`.

## [Unreleased]

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
