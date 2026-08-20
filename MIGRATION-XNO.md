# HoldFun → Nano (XNO) Layer‑2 — Full Migration Proposal

**Goal:** move HoldFun off Solana and run it as a token Layer‑2 settled on the Nano
block‑lattice, reusing the BlackBird playbook (deterministic indexers + threshold
custody + on‑chain data commitments) — 100% of the product, not just a token.

**TL;DR:** Nano has no smart contracts, so "on‑chain rules" become **"signed Nano
blocks (data) + a deterministic indexer that computes the token ledger + threshold‑
signed custody for the one real asset (XNO liquidity)."** The 5% cap, staking,
rebates and burn all become *deterministic, independently verifiable state* —
enforced by "every honest indexer and client rejects an invalid block," exactly the
same trust pattern BlackBird uses for its Merkle roots.

---

## 1. Why this actually fits HoldFun

| HoldFun need | Nano property |
|---|---|
| Token transfers (stake, buy, sell, claim) | Feel‑less, sub‑second, final — no gas is a *huge* UX win |
| 5% cap / supply lock / burn | Deterministic ledger, no one can print because supply is derived from the launch block |
| Rebase/rebates (stake × time) | Confirmation‑height clock (Nano has no timestamps → use height) |
| Creator can't rug | Pool XNO in threshold custody; token ledger has no "owner" key at all |
| Trading | Constant‑product math ported 1:1 (it's just arithmetic over two reserves) |

---

## 2. Core architecture (4 pieces)

```
┌──────────────┐        ┌─────────────────────────┐
│  User (web)  │◄──────►│  Nano Ledger (base layer) │
│  HoldFun UI  │  signed data blocks               │
└──────┬───────┘        └──────────┬──────────────┘
       │ reads/verifies            │ events
       ▼                           ▼
┌─────────────────────────┐  ┌───────────────────────────┐
│  Indexer Network        │  │  XNO Custody (threshold)  │
│  deterministic token    │  │  signs XNO payouts only   │
│  ledger (balances, pool,│  │  (sells, claims in XNO)   │
│  stakes, rebates)       │  │                            │
└─────────────────────────┘  └───────────────────────────┘
```

1. **Token = a Nano account (the "mint") + a ledger derived from signed blocks.**
   Token balances are *not* Nano balances — they live in the indexer's state,
   deterministically derived from data blocks. This is why the 5% cap and burn are
   enforceable: there is no private key that can print tokens.

2. **Every operation is a Nano block.** Nano's `link`/`representative` fields (32B
   each) carry the op code + payload. The block's own `account` is the "from", its
   `previous` is the per‑account nonce (gives double‑spend protection for free).

3. **Indexers** replay blocks and compute the canonical token state (the same
   "any honest indexer produces the same result" guarantee BlackBird uses).

4. **XNO custody** is the *only* place a signature can move real value: the pool's
   XNO. Buys are trustless (user sends XNO to the pool account). Sells pay XNO out,
   which needs a `t‑of‑n` threshold signature over that exact payout block.

**Key simplification vs BlackBird:** no ZK proofs (HoldFun has no privacy goal).
The only crypto we need is Nano's native Ed25519‑blake2b + a threshold‑signing
scheme for the XNO pool.

---

## 3. Token standard on Nano

A token is registered by a **launch block** signed by the creator:

```
block.account  = creator Nano account
block.link     = LAUNCH ‖ token_id ‖ name_hash ‖ supply ‖ decimals ‖ ipfs_cid
block.representative = creator (or a protocol anchor address)
```

`token_id` = the mint account's public key (or the launch block hash). Indexers
validate:

- `creator_share = floor(supply × 5%)` (hard‑coded, else the block is **invalid**).
- `community_share = supply − creator_share` is assigned to the **treasury** virtual
  account (a deterministic ledger address — no key controls it).

From then on:

- **Transfer / buy / sell / stake / unstake / claim** = data blocks `link = OP ‖ token_id ‖ …` signed by the sender's Nano key.
- **Burn** = a state transition that subtracts from `total_supply` in the ledger. No key, no authority — just the deterministic unstake rule (5% of the exit tax).
- **Supply is locked** because no block exists in the state machine that can increase `total_supply` after launch. "Mint authority" simply does not exist in the model.

Double‑spend safety: a token account's operations are chained by the Nano block
`previous` field; indexers reject forks. Nano's ORV gives the canonical order.

---

## 4. Mapping every HoldFun feature

| Solana today | Nano L2 equivalent |
|---|---|
| SPL mint + `mint_supply` (5%/95%) | Launch block; indexers verify `creator_share = 5%` and mint the ledger balances |
| `renounce` (burn mint authority) | No concept of mint authority — supply is derived, nothing to renounce |
| Constant‑product AMM (`swap_sol_for_hold`) | Buy: user sends XNO → pool account (native) + `SWAP` data block; indexers credit tokens via the exact same `constant_product_out` |
| (`swap_hold_for_sol`) | Sell: `SWAP_BACK` data block; indexers compute XNO_out; **threshold signers** pay XNO pool → user |
| Staking (`stake`) | `STAKE` data block; tokens move user → stake vault in the ledger |
| Exit tax (`unstake` 20% = 5% burn + 15% rebate) | Deterministic `unstake` rule: 80% → user, 15% → rebate vault, 5% → burn (subtract from supply) |
| Rebates (`claim_rebate`, `reward_per_point`) | Same math; **time = confirmation height** instead of unix seconds |
| `initialize_pool` / `add_liquidity` | Creator `SEED_LIQ` / `ADD_LIQ` data blocks + XNO to the pool; indexers move treasury tokens into the pool ledger |
| Chart / market data | Replay `SWAP` blocks (already how it works) — history is fully on Nano |
| Token images | IPFS (unchanged — Pinata JWT already working) |
| 5% cap UI / safety flags | Client reads indexer state and shows the same badges |

---

## 5. Enforcement model — the honest part

This is the **one real trade‑off** vs Solana. On Solana the 5% cap is *immutable
in a program*. On Nano there is no program, so the guarantee becomes:

1. **Deterministic rules** — supply/creator‑share/burn are pure functions of the
   ledger. Any indexer or client can recompute and detect a violation.
2. **Client verification** — the web app fetches state from ≥2 indexers, recomputes,
   and refuses to show/execute anything that breaks a rule (a "launch" with >5% is
   simply not rendered).
3. **Threshold custody** — the only real value (pool XNO) can't move without
   `t‑of‑n` signers, who *independently re‑verify the state transition* before
   signing (mirrors BlackBird guardians).

**Honest limitation (from BlackBird §11):** Nano cannot automatically seize funds.
A malicious guardian can be excluded via re‑sharing and a supermajority, but there
is no on‑chain slashing. For HoldFun this is acceptable because the *token* ledger
needs no keys at all — the residual risk is limited to the pool's XNO, which is
small relative to each token's supply.

---

## 6. XNO custody (the only real‑funds piece)

- **Pool account** = Nano address derived from an aggregate threshold public key.
- **Buys** (XNO in): ordinary Nano sends to the pool address. No signature needed.
- **Sells / creator‑liquidity withdrawals in XNO** (only the pool depth): a
  coordinator collects `t` partial signatures (FROST over Ed25519‑blake2b, or plain
  `t‑of‑n` multi‑sig for v1) over the exact payout block; each signer first replays
  the sell against the indexer state and verifies the `XNO_out` amount.
- Same deployment shape as BlackBird: **1 coordinator VPS + 2 cosigner VPSes** in
  separate regions. For dev/test, a 2‑of‑3 Nano multi‑sig is fine.

---

## 7. Indexer network (reuse BlackBird's pattern)

- Stateless, deterministic: reads Nano blocks → computes token state → serves an API
  (`/token/<id>`, `/balances`, `/pool`, `/price/<id>`, `/history/<id>`).
- Multiple independent indexers; clients require agreement (quorum) before trusting.
- Publishes a `RootCommit`‑style anchor block (state hash in `link`) so the latest
  state hash is on‑chain and censorship‑resistant.
- v1: a single indexer + the web app itself recomputing is enough to start.

---

## 8. Client / UX

- Reuse the entire existing Next.js UI (pump‑fun theme, buy/sell, liquidity panel,
  avatars, chart, lists) — only the SDK layer changes.
- Swap `@solana/web3.js` + Anchor for a thin `@holdfun/nano` client: signs Nano data
  blocks, talks to indexers, computes local PoW (or uses `rpc.nano.to` for work).
- Wallet: Nano keys (Nault/nautilus) instead of Phantom. The app is effectively the
  wallet for the L2 token (wallets won't natively show it — same as any Nano L2).

---

## 9. Migration plan (100% cutover)

| Phase | Deliverable |
|---|---|
| **0 — Spec** | This doc + encoding spec + state‑machine spec (exact `link` layouts, rules) |
| **1 — Core** | Nano testnet: mint, transfer, 5% launch validation, single indexer, state API |
| **2 — Trade + custody** | Constant‑product buy/sell, pool XNO custody (2‑of‑3), sell payouts |
| **3 — Stake/rebates** | Stake/unstake/claim, 20% tax + burn + rebates on a confirmation‑height clock |
| **4 — UI swap** | Port the existing Next.js app onto the Nano client + indexer API (reuse 90% of components) |
| **5 — Snapshot & genesis** | Snapshot Solana HoldFun holders → issue a **migration mint** on Nano that airdrops balances 1:1 |
| **6 — Cutover** | Freeze the Solana program (`--final` / read‑only), point `app‑theta‑eight‑74.vercel.app` at Nano, announce |

**What can't migrate automatically:** the actual XNO/SOL value and the Solana
token balances — they move only by holder action or via the snapshot‑airdrop in
Phase 5. "100% migration" = product/brand/UX + a 1:1 holder airdrop, not a
cross‑chain asset bridge.

---

## 10. Reusable vs new

**Reuse as‑is:** the whole frontend (theme, GameCard, SwapPanel, LiquidityPanel,
PriceChart, avatar generator, IPFS upload route), the tokenomics math
(`constant_product_out`, `reward_per_point`, the 20/5/15 tax split), and the
market/chart reconstruction logic.

**New work:** the Nano block encoding + state machine (Rust or TS), the indexer,
the XNO custody (FROST or multi‑sig), the Nano client SDK, and the guardian/
coordinator VPSes.

---

## 11. Risks (explicit)

1. **Weaker enforcement** — deterministic‑validation + custody replaces contract
   immutability. Honest, but different.
2. **New infra** — indexer + guardians must be run; the app is no longer a single
   Vercel deploy.
3. **No automatic slashing** on Nano.
4. **No native wallet support** for the token (app‑as‑wallet only).
5. **Nano has no timestamps** — rebates use confirmation height (fine, but changes
   the "N days avg hold" UX slightly).
6. **`link`/`representative` size** (32B) — complex ops may need 2 blocks.

---

## Recommendation

This is a **good migration for HoldFun** — feel‑less transfers and a keyless token
ledger fit the "no‑rug, community‑held" brand better than a gas‑fee chain, and
BlackBird already proved the indexer + threshold‑custody pattern works on Nano.

I'd start with **Phase 0–1** (spec + core mint/transfer/indexer on Nano testnet) as
a spike, because the whole bet rests on the deterministic‑ledger model — everything
else (trade, stake, UI) is a port of code we already have.

Want me to (a) write the detailed **encoding + state‑machine spec** (Phase 0) next,
or (b) scaffold the **Nano testnet spike** (mint + transfer + single indexer) to
prove the core loop?
