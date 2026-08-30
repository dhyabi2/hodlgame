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
`futOpen(size, margin, side, guard)` (body
`[size 15B][margin 15B][side 1B][guard 15B][zero 1B]`, side 0 = long, 1 = short;
any other side byte or non-zero padding is rejected).

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
(of supply), `MAX_OI_POOL_BPS = 1000` (of the token reserve),
`MARK_RESPONSIVENESS = 4`, `MIN_SIZE_DIV = 10_000`, `MAX_BOOK_SIDE = 32`,
`MAX_ORDERS_PER_ACCOUNT = 2`, `MAX_PAIRS = 128`, `MAX_SETTLED = 32`.

**Spot.** `spot = poolXno × PRECISION / poolTokens`. Invalid (`no liquidity`)
when either reserve is 0.

**The mark, and why it carries no clock.** A lagging reference is required —
spot can be pumped inside one op for the swap fee. It must *not* be
time-weighted: a block's timestamp is `local_timestamp`, the moment the
answering node first saw it. It is not covered by the signature and differs
between nodes. Ordering already tolerates that because sorting is a DISCRETE
function of timestamps; a time-weighted average is a CONTINUOUS one, so a
one-second difference would change entry prices, balances and the state root,
and the server and the in-browser verifier would disagree. The reference is
therefore anchored to VOLUME, which is consensus state. After every
price-moving op on an active token:

```
frac = max( |Δ poolXno| / max(poolXno_before, poolXno_after),
            |Δ poolTokens| / max(poolTokens_before, poolTokens_after) )
mark += (spot − mark) × min(1, MARK_RESPONSIVENESS × frac)
```

Taking the larger of the two reserve moves is required: `addLiq(xno = 0,
tokens = …)` is creator-only and free and repositions spot while moving no XNO
at all, which would otherwise leave a stale reference for a resting maker to
harvest a taker against. Cumulative volume `V` closes `1 − e^(−4V/pool)` of any
gap, so moving the reference means pushing a comparable fraction of the pool's
own liquidity through the curve — paying the swap fee and the slippage, both
ways, while everyone else can trade against you. `mark` is seeded from spot at
the token's first `futOpen` and is one bigint of state.

**Adverse pricing.** Let `lo = min(spot, mark)`, `hi = max(spot, mark)`.
- entry of a new pair: the **taker** gets the worse side — long taker `hi`,
  short taker `lo` (the maker inherits the same entry, which is its good side);
- voluntary close: the pair settles at the price worse for the **closer** —
  long closer `lo`, short closer `hi`;
- liquidation: fires only if the losing side is at/below maintenance at
  **both** `spot` and `mark`, and settles at the price more favourable to that
  loser.

**State.** `futures: { book, pairs, nextId, mark, settled, nextSeq }` per token.
`FutOrder = {id, account, side, size, margin, guard}` (resting, FIFO);
`FutPair = {id, size, entry, long: {account, margin}, short: {account, margin}}`;
`FutSettled = {seq, id, size, entry, price, long, short, longPnl, kind (0 close
/ 1 liquidation), closer}` — every settlement appends a receipt, bounded to the
most recent 32, each carrying a unique monotone `seq` so a derived history can
never confuse two identical settlements. Margin tokens leave `balances` while
locked. Conservation (fuzz-tested): `Σbalances + Σstaked + treasury +
poolTokens + rebateVault + lockedMargin == supply`. The canonical root carries a
`futures` key **only once a token has futures activity**, so every pre-futures
root is byte-identical (verified against the live production root).

**`futOpen(side, size, margin, guard)`** — fragment-encoded. Valid iff the
carrier's timestamp is a finite number `≥ FUTURES_ERA` (written as a positive
test, so an absent/NaN stamp fails), token launched and priced, `size > 0`,
`margin > 0`, `guard > 0`, `size ≤ margin × MAX_LEVERAGE`, `size ≥ minSize =
max(supply/MIN_SIZE_DIV, BPS/MAINT_BPS)`, `balance ≥ margin`, that side's open
interest + size `≤ min(supply × MAX_OI_BPS, poolTokens × MAX_OI_POOL_BPS)/BPS`,
the taker-adverse `entry` satisfies the guard, and — if the order would have to
rest — there is room under `MAX_BOOK_SIDE` and `MAX_ORDERS_PER_ACCOUNT`.
Matches FIFO against resting opposite-side orders not owned by the sender and
whose own `guard` the entry satisfies, stopping at `MAX_PAIRS`. A fill that
would leave either party below `minSize` is skipped rather than made. Any
remainder rests if it is `≥ minSize` and there is room, else it is refunded.

**`guard`** is the signer's entry-price bound (long: `entry ≤ guard`; short:
`entry ≥ guard`) and is **mandatory**. The fixpoint defers an invalid op and
retries it after every later apply (§9), so without a bound an open could fire
at a price its signer never quoted; and because one large swap always
dislocates spot further than the mark, an unguarded taker is harvestable by a
maker who moved the price on purpose.

**`futClose(size)`** — compact. `size = 0`: refund every resting order of the
sender and close all their positions; else close FIFO up to `size`. A partial
close must both take and leave at least `minSize`, otherwise it closes the
whole pair: `pnl`, the prorated margins and the fee all floor, so slicing a
losing pair into dust would otherwise round every one of them to zero and let
the loser pay neither. Each closed portion settles **both** legs at the
closer-adverse price `P`: `pnl_long = portion × (P − entry) / P`, clamped to
`[−longMargin, +shortMargin]`; the closer pays `portion × CLOSE_FEE_BPS / BPS`
(capped at their payout) to the counterparty. **Closing nothing is a no-op, not
an invalid op** — an invalid one would be deferred and fire against a position
the signer opened later.

**Liquidation sweep** — after every op that moves the price (buy, sell,
seedLiq, addLiq, and a §8 `applyVoid`) and after every futures op: each pair
whose losing side is at/below `size × MAINT_BPS / BPS` at both prices is
settled loser-favourably with no fee, in ascending pair id. Settlement never
trades against the pool, so a liquidation cannot move the price — no cascades.

**Interaction with §8.** `sellValueOf` counts an account's futures margin as
part of its position, and `applyVoid` prorates the void across balances, stake
**and** futures margin. Otherwise one `futOpen` with `margin = whole balance`
would make the position look like zero, ratchet the earmark floor to 0 and free
the holder to spend collateral other sellers' quotes are backed by.

**Guarantees.** Zero-sum per pair; solvent by construction (no insurance fund);
a pure function of the ordered block list with no clock in it; era-gated so no
historical block can decode into a futures op that applies; a single large
trade can neither liquidate nor be cashed out; no position can exist that is
too small to be liquidated; book and pairs are bounded by count, which matters
because Nano is feeless.

**Not claimed.** A trader who can push volume comparable to the pool's own
liquidity, and hold the price there while everyone trades against them, can
still move the mark and liquidate counterparties. That is bounded by
`MAX_OI_POOL_BPS` (the prize) and by the loss cap (a loser can never lose more
than their margin), but it is a cost, not an impossibility — as on any venue
with a thin market.
