# HoldFun on Nano — Phase 0 spec (encoding + state machine)

This defines the deterministic core the whole L2 rests on. If two implementations
replay the same Nano blocks, they must produce byte-identical state. Everything
below is deliberately free of timestamps and network calls.

## 1. Actors & accounts

- **Creator** — the Nano account that signs the `launch` block.
- **Token ledger** — a virtual ledger (balances/stakes/pool), derived by indexers.
  It has **no key**; its only "authority" is the deterministic rule set below.
- **Pool account** — a Nano address holding XNO. Buys are trustless sends to it;
  sells are paid out by a `t-of-n` threshold signature (custody, not part of this
  state-machine spec).
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
unstake=0x06, claim=0x07, seedLiq=0x08, addLiq=0x09`.

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
  supply              // total outstanding; only ever decreases (burn)
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
TAX_BURN_SHARE_BPS = 2_500         // 25% of tax = 5% of amount, burned
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
- `tax = amount*TAX_BPS/BPS`; `burn = tax*TAX_BURN_SHARE_BPS/BPS`;
  `rebate = tax-burn`; `toUser = amount-tax`.
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
