# HodlGame on Nano — spec (encoding + state machine)

This defines the deterministic core the whole L2 rests on. If two implementations
replay the same Nano blocks, they must produce byte-identical state. Everything
below is deliberately free of timestamps and network calls.

## 1. Actors & accounts

- **Creator** — the Nano account that signs the `launch` block.
- **Token ledger** — a virtual ledger (balances/stakes/pool), derived by indexers.
  It has **no key**; its only "authority" is the deterministic rule set below.
- **Pool account** *(legacy lane — tokens launched with `0x01` only)* — a Nano
  address holding XNO. Buys are trustless sends to it; sells are paid out by a
  `t-of-n` threshold signature (custody, not part of this state-machine spec).
  **Direct-Settlement v2 tokens (launched with `0x0b`) have no pool account at
  all** — see §8.
- **Indexer** — replays blocks, serves `/state`, `/balance`, `/price`, `/history`.

## 2. On-chain encoding

Each operation is a Nano **state block** where:

| Field | Use |
|---|---|
| `account` | the sender (creator for launch, any holder for others) |
| `previous` | per-account nonce → gives free double-spend rejection |
| `link` (32B) | `opcode(1B) ‖ tokenId(16B) ‖ amount(15B)` (see §2.1) |
| `representative` (32B) | ordinary Nano representative (self for data blocks) |
| `balance` | 0 (data-only block; buys instead carry the XNO value) |

Op codes: `launch=0x01, transfer=0x02, buy=0x03, sell=0x04, stake=0x05,
unstake=0x06, claim=0x07, seedLiq=0x08, addLiq=0x09, withdraw=0x0a,
launchDirect=0x0b` (same byte layout as `launch`; marks the token
**Direct-Settlement / zero-custody**, §8), `futOpen=0x0c` (fragment only),
`futClose=0x0d` (compact; amount = size to close, 0 = close all) — see §10.

Fragment links (`0xE0 | opcode` marker across two chained 1-raw blocks) carry
two-amount ops fully on-chain: `transfer(to, amount)`, `sell(tokens, minXno)`,
`buy(xno, minTokens)` (direct self-earmark buys declare their xno this way),
`seedLiq/addLiq(xno, tokens)` (direct virtual seeds), and
`futOpen(size, margin, side)` (body `[size 15B][margin 15B][side 1B][zero 16B]`,
side 0 = long, 1 = short; any other side byte or non-zero padding is rejected).

Ops that don't fit 31 bytes (e.g. `launch` with name/IPFS CID) are encoded as
**commit-reveal**: `link = blake2b(payload)`, and the payload is fetched from any
indexer (who re-checks the commitment). BlackBird uses the same pattern.

### 2.1 Multi-token identity & routing

- **tokenId** = the first **16 bytes (128 bits)** of the token's `launch` block
  hash — deterministic on-chain, derivable by any indexer, no registry needed.
  (`core/token.ts` `tokenIdFromLaunchHash`.)
- `launch` carries **no** tokenId in `link` (that slot is zero); the id exists
  only after the launch block is signed/broadcast.
- Every subsequent op (`buy`/`sell`/`stake`/…) carries its `tokenId` in the
  `link` high bytes, so the indexer routes the op to that token's own `State`.
- Compact ops carry **one** amount. For `buy` that amount is `minTokens` (the
  slippage guard); the spent XNO is **bound by value**, not declared — see §7.1.
  `sell.minXno` needs a second amount and uses commit-reveal.
- Two-amount / string ops (`seedLiq`, `addLiq`, `transfer`, `sell` with `minXno`)
  use **commit-reveal** (`core/commit.ts`): `link = 0xFF ‖ blake2b(tokenId ‖ encodeOp(op))[0..30]`.
  The `0xFF` prefix disambiguates from compact opcodes (`0x01..0x09`). The full op
  is served off-chain and re-verified against the commitment.
- Indexer state is a `MultiState = Map<tokenId, State>` (`core/multi.ts`); each
  token has its own `supply`/`poolXno`/`poolTokens`/`balances`/`treasury` and its
  own XNO pool account.
- **Off-chain metadata is signed** (`core/metaAuth.ts`, `server/metaAuth.ts`):
  every registry write carries an ed25519-blake2b signature by the token's
  authority over `blake2b("holdfun-meta-v1" ‖ tokenId ‖ seq ‖ action ‖
  hash(sanitized fields))`. Authority = the on-chain launch signer (a
  provisional first-writer holds it only until the launch is indexed, then the
  creator overrides and the row locks). A strictly-increasing `seq` blocks
  replay; `makeImmutable` freezes a row one-way; `setAuthority:<addr>`
  transfers control. The domain prefix keeps metadata signatures and Nano
  block signatures in disjoint digest spaces.

### 2.2 Per-token custody (HD)

A single master seed (`POOL_SEED`) derives every token's XNO pool key:

```
poolSeedForToken(master, tokenId) = blake2b-256(master ‖ tokenId)
tokenPoolKeys(master, tokenId)    = keysFromSeed(poolSeedForToken(...))
```

No per-token secrets are stored; the operator can sign payouts for any token from
the master seed alone (`core/../server/custody.ts`).

## 3. State

```
State {
  id, name, symbol, decimals, image, launched
  supply              // total outstanding; only ever decreases (legacy burn / last-staker burn)
  creator, creatorShare
  balances: account -> tokens
  staked:   account -> tokens
  points:   account -> stake*height (accrued)
  rewardDebt: account -> scaled
  totalStaked, totalPoints, rewardPerPoint
  rebateVault, treasury
  poolXno, poolTokens
  height              // Nano confirmation height, the clock
}
```

## 4. Constants (port of the Solana program)

```
PRECISION = 10^12
BPS = 10_000
MAX_CREATOR_SHARE_BPS = 500        // 5%
TAX_BPS = 2_000                    // 20% exit tax
TAX_BURN_SHARE_BPS = 2_500         // LEGACY era only: 25% of tax = 5% of amount, burned
FULL_REBATE_ERA = 1_787_644_000    // unstakes stamped ≥ this: whole tax to stakers, no burn
SWAP_FEE_BPS = 100                 // 1%
```

## 5. Rules

**launch(supply)** — sender becomes creator.
- reject if `launched`.
- `creatorShare = floor(supply * MAX_CREATOR_SHARE_BPS / BPS)`; reject if 0.
- `balances[creator] = creatorShare`, `treasury = supply - creatorShare`,
  `supply = supply`, `launched = true`.
- The 5% cap is **structural**: the creator never specifies their own share.

**transfer(to, amount)** — `balances[from] >= amount`; move it.

**buy(xno, minTokens)** — XNO arrives at the pool (native value block).
- `out = xno * poolTokens / (poolXno + xno)` (1% fee taken off `xno` first).
- reject if `out < minTokens` or `out >= poolTokens`.
- `poolXno += xno; poolTokens -= out; balances[from] += out`.

**sell(tokens, minXno)** —
- `out = tokens * poolXno / (poolTokens + tokens)`.
- reject if `out < minXno` or `out >= poolXno`.
- `poolTokens += tokens; poolXno -= out; balances[from] -= tokens` (+ XNO payout
  off-chain by custody).

**stake(amount)** — `balances[from] -= amount; staked[from] += amount;
totalStaked += amount` (settle `rewardDebt` first).

**unstake(amount)** — `staked[from] >= amount`; settle points.
- `tax = amount*TAX_BPS/BPS`; `toUser = amount-tax`. Era by the carrier
  block's timestamp: **before `FULL_REBATE_ERA`** `burn =
  tax*TAX_BURN_SHARE_BPS/BPS`, `rebate = tax-burn` (legacy 5%/15%, kept
  bit-exact); **from `FULL_REBATE_ERA`** `burn = 0`, `rebate = tax` while any
  stake remains after the unstake, else `burn = tax` (never stranded in the
  vault).
- `supply -= burn` (permanent deflation); `rebateVault += rebate`;
  `balances[from] += toUser`; `staked[from] -= amount; totalStaked -= amount`.

**claim()** — `pending = points*rewardPerPoint/PRECISION - rewardDebt`; reject if
0; pay from `rebateVault`; clamp to available; settle debt (carry shortfall).

**seedLiq / addLiq(xno, tokens)** — creator only; move `tokens` from `treasury`
into the pool; XNO is sent to the pool account. **Value-bound like buys**: when
`xno > 0` the commit op block must chain (`previous`) from a real XNO send to
the token's pool account, and that deposit's native amount overrides the
declared `xno` (an unbacked declaration is skipped entirely). `xno = 0`
token-only adds need no deposit. Credited seed/add deposits are excluded from
the sweep's refund rule so a creator's seed is never refunded back out.

## 6. Rewards (height clock)

On every block at height `h`:
- `totalPoints += totalStaked * (h - lastHeight)`.
- On `unstake` (which funds `rebateVault`), and on `claim`/`sync`:
  `rewardPerPoint += newRebate * PRECISION / totalPoints` (when `totalPoints>0`).
- A staker's pending is `points*rewardPerPoint/PRECISION - rewardDebt`.

This is the exact Solana `reward_per_point` math with **confirmation height**
substituted for unix time — deterministic and timestamp-free.

## 7. Invariants (what the tests assert)

1. Creator share ≤ 5% (structural) and exactly `floor(supply*5%)`.
2. No op increases `supply` after `launch` (supply only shrinks via burn).
3. `transfer`/`unstake` can't exceed balances/stakes (double-spend rejected).
4. `poolXno * poolTokens` non-decreasing across a swap (fee retained).
5. Unstake splits 80/15/5 exactly (user / rebate / burn).
6. Two independent replays of the same op sequence are byte-identical.

## 7.1 Value-bound buy (no declared-xno trust)

A buy is **two chained blocks** (same account, no smart contract needed):

1. **Deposit** — a native XNO `send` to the token's pool account. The amount is
   the authoritative `xno`.
2. **Buy op** — a 1-raw data block whose `previous` field points to the deposit
   hash; its `link` carries `tokenId` + `minTokens` (slippage guard).

The indexer reads the deposit's native amount and uses it as `op.xno`, so a
buyer can neither under-declare (pool insolvency) nor over-declare (free credit)
— the value and the intent are bound by Nano's own `previous` chain. A rejected
buy (e.g. slippage) is refunded the deposit amount by custody reconciliation
(`poolReceived − creditedBuyXno`), a sender who never depositing cannot refund.
This mirrors the Velas reference's deposit→commitment chain
(`verifyXNOPrivacyProtocol/src/vela_indexer.py`).

## 8. Direct-Settlement v2 (zero-custody tokens)

Tokens launched with `launchDirect (0x0b)` never have a pool account. The AMM
reserves are **virtual** (pure replay quantities); real XNO only ever moves
wallet-to-wallet between players. Nobody — operator included — can custody,
freeze, or redirect traders' money, because nothing ever holds it.

**Virtual seed.** `seedLiq/addLiq` for a direct token is a fragment pair
declaring `(xno, tokens)`. The declared xno is a price-curve setting, not a
deposit — it claims no real money and costs 2 raw. A creator dumping their 5%
into fresh virtual liquidity receives exactly **zero** until real buyers have
committed real collateral (their sell has no earmark, and the queue quotes at
coverage 0).

**Buy — two lanes.**
1. *Queue-routed*: the buy op chains from a real XNO send **to a queued
   seller's own address** (validity-bound to the deposit's destination). Tokens
   mint through the curve on `min(amount, that seller's residual owed)`; any
   excess is recorded as the seller's `prepaid` (nets their future proceeds,
   never a second mint).
2. *Self-earmark* (only when no seller is owed): a fragment buy declares its
   xno; validity requires the **signed carrier-block balance** ≥ xno + the
   buyer's existing floor. Nothing moves — the amount stays in the buyer's own
   wallet as **earmarked collateral at cost**.

**Earmarks, floors, policing.** Each earmark holder has a **ratcheting floor**
`= min(earmark, current sell-value of the position)` — it only ever falls, and
released collateral returns to the holder's free control. Every block of every
watched chain contributes its **signed balance** as an observation event; if an
account's balance drops below the **sum of its floors across all direct
tokens**, each position is voided proportionally (tokens return to the virtual
reserves, queued claims shrink, earmark/floor drop to what the chain proves).
One XNO can never double-count as collateral in two games.

**Sell — three-layer netting.** Quote `out` on the curve, then net in order:
(1) `prepaid`; (2) **self-net** `min(remainder, earmark, signed exit-block
balance)` — settled instantly by releasing the seller's own collateral, zero
counterparty (the actual-balance cap means a defector cannot self-net what the
chain proves gone); (3) the rest — realized appreciation — joins a FIFO
**queue**, quoted at `face × min(1, R)` where coverage
`R = Σ other holders' floors / total claims`; the haircut's shaved part returns
to the virtual reserves. The accounting identity (regression-tested): **the
flow-backed queue equals exactly unpaid exit-realized appreciation** (+
defection shortfalls). `withdraw` is **invalid** on direct tokens — they settle
at sell.

## 9. Canonical order & replay (applies to all tokens)

- **Order**: events sort by `(era, timestamp?, lamport, height, hash, sub)`,
  where `era` is 0 for blocks first seen before `TIME_ORDER_ERA` (a published
  constant, 2026-08-24 ~14:00 UTC) and 1 after. Within era 1 the primary key
  is the block's network-observed first-seen time (`local_timestamp`): every
  trade was quoted against the state at its broadcast time, so time-order is
  the order under which those quotes stay honest. Lamport clocks — `lam(b) =
  1 + max(lam(previous), lam(source send))` for receives/opens (unknown
  external sources count 0) — break same-second ties causally, but cannot be
  primary: two externally funded wallets have no lattice edge between them,
  so a fresh wallet's near-zero clocks would insert its trades *before*
  days-older history and re-price it until the older trades' own slippage
  guards invalidated them. Era-0 history ignores timestamps entirely (legacy
  lamport-primary keys): it was already served — and quoted against — under
  that order, so re-sorting it would redistribute balances users hold today.
  `sub` orders a block's op (0) before its own balance observation (1).
  Timestamps are ledger-persistent per node but not signature-covered: a
  hostile RPC can reorder concurrency (never forge blocks), and validity is
  order-independent (fixpoint deferral) — the operator's monotonic block
  store pins first-fetched chains so served history only refines forward.
- **Stable fixpoint replay**: events fold in canonical order; an op that is
  invalid *now* is deferred and retried after **every** subsequent successful
  apply, so it anchors at the **earliest point it becomes valid**. Appending
  later events can never change where an earlier event applied — history never
  re-prices (time-primary ordering is what guarantees newly discovered blocks
  actually append rather than insert). Every replayer runs the identical
  procedure over the identical ordered list, so state stays byte-identical.

## 10. Futures — token-margined inverse positions (`core/futures.ts`)

**Why this is the only trustless derivative possible on Nano.** The chain can
never seize XNO, but a HodlGame token exists *only* as replay state — so margin
posted **in the token** is enforceable by consensus. A loss is a balance move
inside `State`; no escrow, no operator key, no oracle. Futures never touch XNO
or the spot invariants (§8: earmarks, floors, `queue == unpaid appreciation`).

**Constants.** `FUTURES_ERA = 1_788_100_000` (2026-08-30 14:26:40 UTC),
`MAX_LEVERAGE = 5`, `MAINT_BPS = 500`, `CLOSE_FEE_BPS = 50`, `MAX_OI_BPS = 2500`
(of supply), `MAX_OI_POOL_BPS = 5000` (of the token reserve), `TWAP_WINDOW = 600`
seconds, `MAX_SAMPLES = 64`.

**Spot.** `spot = poolXno × PRECISION / poolTokens` — the token's own
replay-computed price. Invalid (`no liquidity`) when either reserve is 0.

**TWAP reference (manipulation resistance).** Spot can be pumped inside one
op for ~2% swap fees, and op-count windows are free to spam on a feeless chain,
so the reference is **time**-weighted: after every price-moving op on an
*active* token (one that has had a `futOpen`), the carrier's network timestamp
and the spot are appended to `futures.samples` (same-second → latest wins;
times clamped non-decreasing; one sample at/before the window start is kept,
older ones pruned; at most `MAX_SAMPLES`, dropping the oldest in-window first).
`twap(now)` = average of spot over `[now − TWAP_WINDOW, now]` where each sample
holds until the next and the **first sample is extended back to the window
start**; with no timestamp or no samples, `twap = spot`. Sampling never starts
before the first `futOpen`, so no pre-futures root changes. Holding a pump for
the whole window lets every other holder sell into it — that is the
manipulator's real cost.

**Adverse pricing.** Let `lo = min(spot, twap)`, `hi = max(spot, twap)`.
- entry of a new pair: the **taker** gets the worse side — long taker `hi`,
  short taker `lo` (the maker inherits the same entry);
- voluntary close: the pair settles at the price worse for the **closer** —
  long closer `lo`, short closer `hi`;
- liquidation: fires only if the losing side is at/below maintenance at
  **both** `spot` and `twap`, and settles at the price more favourable to that
  loser (long loser `hi`, short loser `lo`).

**State.** `futures: { book: FutOrder[], pairs: FutPair[], nextId, samples,
settled }` per token. `FutOrder = {id, account, side, size, margin}` (resting,
FIFO); `FutPair = {id, size, entry, long: {account, margin}, short: {account,
margin}}`; `FutSample = {t, price}`; `FutSettled = {id, size, entry, price,
long, short, longPnl, kind (0 close / 1 liquidation), closer}` — every
settlement appends a receipt to `settled` (bounded to the most recent 32,
oldest dropped; the full history is derivable from the fold, and each entry
ties to the block that settled it).
Margin tokens leave `balances` while locked. Conservation (tested):
`Σbalances + Σstaked + treasury + poolTokens + lockedMargin == supply`.
The canonical root carries a `futures` key **only once a token has futures
activity** (`nextId > 0` or a non-empty book/pairs) — every pre-futures root is
byte-identical to before (verified against the live production root).

**`futOpen(side, size, margin)`** — valid iff stamped `≥ FUTURES_ERA`, token
launched and priced, `size > 0`, `margin > 0`, `size ≤ margin × MAX_LEVERAGE`,
`balance ≥ margin`, and that side's open interest (book + pairs) + size
`≤ min(supply × MAX_OI_BPS, poolTokens × MAX_OI_POOL_BPS) / BPS`. Deducts
`margin`, then matches FIFO against resting opposite-side orders **not owned
by the sender** (partial fills; maker and taker margin are prorated by fill /
original size, rounding dust refunded). Each fill creates a pair at the
taker-adverse `entry`. Any unmatched remainder rests in the book with its
prorated margin. The token's first `futOpen` records the first TWAP sample.

**`futClose(size)`** — `size = 0`: refund every resting order of the sender and
close all their pairs; else close the sender's pairs FIFO up to `size`
(partial). Each closed portion settles **both** legs at the closer-adverse
price `P`: `pnl_long = portion × (P − entry) / P` (tokens), clamped to
`[−longMargin, +shortMargin]` (loss never exceeds what the loser locked);
the closer pays `portion × CLOSE_FEE_BPS / BPS` (capped at their payout) to the
counterparty it closed. Invalid (`nothing to close`) if the sender had nothing.

**Liquidation sweep** — after every op that moves the price (buy, sell,
seedLiq, addLiq) and after every futures op: each pair whose losing side's
equity `margin ± pnl ≤ size × MAINT_BPS / BPS` at **both** spot and twap is
settled at the loser-favourable price with no fee, in ascending pair id. A
pure no-op for tokens with no pairs. Settlement never trades against the pool,
so a liquidation cannot move the price — no cascades.

**Guarantees.** Zero-sum per pair; solvent by construction (no insurance
fund); deterministic (identical fold on every replayer); era-gated so no
historical block can ever decode into a futures op that applies; a one-op
price move can neither liquidate nor be cashed out.
