# How HodlGame Works — Building a Token Economy on a Chain With No Smart Contracts

HodlGame is a memecoin launchpad and trading game that runs entirely on **Nano
(XNO)** — a feeless, instant, pure **payment** network. Nano has **no virtual
machine, no smart contracts, no scripting, no covenants, no timelocks**. Every
account is a single Ed25519 keypair, and the only thing an account can do is
sign a `state` block that moves its own balance. That is the whole instruction
set.

So how do you get a launchpad, an AMM, staking, rewards, leaderboards, and a
zero-custody settlement engine out of a network that can only "send money from A
to B"? This document explains the trick end to end, honestly, including what is
and isn't trustless.

---

## 1. The core idea: a deterministic Layer‑2 replayed from signed blocks

There is **no contract holding state**. Instead, the entire token economy is a
**pure function of public Nano blocks**:

```
state = replay(all signed blocks, in a canonical order)
```

Every game action — launch a coin, buy, sell, stake, unstake, claim, transfer,
seed liquidity — is encoded into the **32‑byte `link` field** of an ordinary
Nano block the user signs from their own wallet. An **indexer** reads those
blocks from public Nano RPC, decodes each one into an operation, and folds them
into token state with a **pure, deterministic state machine** (`core/state.ts`).

The trust model is one sentence:

> **Two independent implementations that replay the same blocks MUST produce a
> byte‑identical state root.**

That is the "consensus." There is no privileged sequencer deciding balances —
the blocks are already ordered and confirmed by Nano's own network; the L2 just
interprets them the same way for everyone. The web app even ships the indexer to
the **browser**, so a visitor can recompute the entire game from public RPC and
compare fingerprints with the server. *Don't trust — verify.*

### Why this is possible without smart contracts

A smart contract is just *shared, enforced computation over shared state*. Nano
gives us the two hard parts for free:

- **Authentication** — every block is Ed25519‑signed, so "who did this" is
  unforgeable.
- **Ordering & finality** — Nano's block‑lattice already totally-orders each
  account's chain and finalizes it via ORV (Open Representative Voting).

What Nano *doesn't* give us is *execution*. We supply that off‑chain, but
**deterministically** — the computation is a pure function anyone can re‑run, so
"enforced" becomes "independently verifiable" instead of "trust the operator."

---

## 2. Encoding operations into a payment network

Each op rides in a block's `link` (normally the destination of a send). We
repurpose it:

```
[ opcode : 1 byte ][ tokenId : 16 bytes ][ amount : 15 bytes ]
```

- `opcode` — launch (`0x01`), transfer, buy, sell, stake, unstake, claim,
  seedLiq, addLiq, withdraw, and **launchDirect (`0x0b`)** for zero‑custody
  coins.
- `tokenId` — the 128‑bit prefix of the launch block's hash (so a coin's id is
  derived from the very block that created it — unforgeable and self‑naming).
- `amount` — the primary quantity.

The op block itself carries **1 raw** (the smallest Nano unit) so it's
distinguishable from a value transfer and costs effectively nothing.

**Value‑binding.** Amounts that represent *real XNO* (a buy deposit, liquidity
seed) are never *declared* — they're taken from the **native amount of the
chained send** the op links to. You can't claim you paid 100 XNO; the indexer
reads what your signed block actually moved. Ops that need more than 15 bytes
(a transfer's 32‑byte recipient, a slippage‑protected sell's two amounts) span a
**fragment pair**: two chained blocks assembled into one op, with the trailing
bytes verified so nothing can be smuggled.

Because a coin's decimals are pinned into its launch block, and the state root
excludes off‑chain cosmetics (name/image), two verifiers with different metadata
mirrors still agree on every balance.

---

## 3. The AMM without a pool contract

Trading is a **constant‑product AMM** (`x·y=k`), the same math Uniswap uses — but
there's no pool contract to hold the reserves. Two designs exist:

### Legacy pooled tokens (opcode `0x01`)
XNO deposits chain into a **pool account** the protocol derives; sells credit an
in‑game balance; an explicit withdraw settles real XNO out, paid by a sweep. The
pool account is a real Nano account, and settling it requires its key — so this
design has a **custodial key** (`POOL_SEED`). Fine, but not fully trustless. It's
retained only for coins launched before v2.

### Direct‑Settlement v2 — zero custody (opcode `0x0b`, the default)
This is the interesting part. **There is no pool account at all.** The AMM
reserves are *virtual* — just numbers in the replay that define the price curve.
Real XNO only ever moves **wallet‑to‑wallet**:

- **A buy** either (a) pays a queued seller **directly** (the buyer's send goes
  straight to that seller's wallet — the op is only valid if the send's
  destination *is* the queue head), or (b) if no one is waiting to be paid, the
  XNO **stays in the buyer's own wallet** as *earmarked collateral* backing their
  position. Nothing is deposited anywhere.
- **A sell** settles in three layers: any prepayment nets first; then the
  seller's own collateral is **released instantly** (their XNO never left their
  wallet, so this is unconditional and counterparty‑free); and only the
  **realized profit** — which is by definition future buyers' money, exactly as
  in *every* AMM — becomes a **FIFO claim** paid by subsequent buys, quoted at a
  live coverage ratio the seller sees before committing.

The verified accounting identity is: **the flow‑backed queue equals exactly the
unpaid, exit‑realized appreciation** — never a phantom claim. (This is enforced
by netting each exit against `min(quote, cost, actual on‑chain balance at the
exit block)`, and it's an executable regression test.)

**Collateral honesty without locks.** Nano can't lock funds (no covenants), so
how do we know a buyer's "collateral" is really there? Every block carries a
signed balance; the replay treats each account's balances as **consensus
observations** and, if someone spends below the floor they committed, their
position is **voided proportionally** — automatically, deterministically, for
everyone to see. Ratcheted floors (which only ever fall) make defection weakly
dominated. So collateral is enforced by *replay‑side validity*, not by a lock
the chain doesn't have.

**The anti‑rug property is mechanical.** A creator is hard‑capped at **5%** at
launch (computed structurally — nobody can request more). And a creator dumping
that 5% into fresh virtual liquidity earns **exactly zero** until real buyers
commit real collateral — proven with the AMM's own numbers.

---

## 4. Why it encourages holding (the "game")

Most launchpads reward whoever exits first; the patient are left holding the bag.
HodlGame inverts that with two protocol rules:

- **Staking pays holders.** Stake your tokens to earn a share of the reward
  vault, distributed **pro‑rata by stake** using a bounded `rewardPerShare`
  accumulator (not block height, which an account could inflate).
- **Quitters pay the stayers.** **Unstaking costs a 20% exit tax, and all of
  it is redistributed to everyone still staked**, pro-rata by stake, in the
  coin's own tokens. (If the last staker leaves, the tax is burned rather than
  stranded. Before 2026-08-25 the split was 5% burn / 15% to stakers; that
  history replays unchanged.)

The house edge points at the *quitters*, not at you. Patience is the strategy
that gets paid — hence "the game where holding wins."

Every one of these numbers is a pure function of public ledger data, so it's all
verifiable and none of it can be faked.

---

## 4b. Futures without a contract (token-margined)

Every "trustless perp" on a chain without scripts is secretly a custodian:
someone must hold a key that can seize the loser's collateral. HodlGame sidesteps
this with one observation — **the token itself is replay state**. Nano can't
take XNO from anyone, but the deterministic ledger *can* move tokens, because
the ledger is the only place they exist. So margin is posted in the token, a
loss is a balance move inside the state machine, and nobody ever holds
anything.

- Open a long or short (`futOpen`) with up to 5× leverage; your margin is locked
  from your token balance and matched FIFO against the opposite side.
- The price is the token's own replay-computed spot — no oracle, nothing
  external.
- Close (`futClose`) settles both sides at the current price; a losing side can
  never lose more than it locked, so the system is solvent with no insurance
  fund. Liquidation is a deterministic sweep every replayer runs identically.
- It is a closed loop in token units: XNO, earmarks and the sellers' queue are
  untouched. Spec §10.

## 5. Ordering, determinism, and the hard problems

Because balances depend on *order*, and Nano only totally-orders *within* an
account (not across accounts), the L2 needs a deterministic **global** order that
every replayer computes identically:

- **Lamport causal clocks** derived from the lattice itself (`lam(b) = 1 +
  max(lam(previous), lam(source send) for receives)`) order cross‑account events
  by how value actually flowed — a wallet funded after a launch sorts after it.
- **A stable fixpoint replay**: an op that's momentarily invalid in canonical
  order (e.g. a buy that sorts before its token's seed) is *deferred* and
  retried, anchoring at the earliest point it becomes valid — and appending
  later blocks can never retroactively re‑price history.

These are the subtle bits that make "replay the same blocks → same state" hold
under adversarial input.

---

## 6. What is and isn't trustless (honest accounting)

- **Consensus / balances:** fully verifiable. Anyone (including in‑browser)
  replays public blocks to the same state root. No trust in the operator for any
  balance.
- **Direct‑Settlement v2 coins:** **zero custody.** No pool key, no operator key,
  nothing that can be rugged or seized — money only moves between wallets, and
  every position is collateral‑checked by the ledger.
- **Legacy pooled coins:** custodied by a single operator key (`POOL_SEED`) —
  the reason v2 exists. (A FROST 2‑of‑3 threshold path is implemented but was
  never activated in production; v2 removes the question entirely.)
- **RPC:** the app talks to public Nano RPC (`rpc.nano.to` primary, keyless
  `rpc.nano-gpt.com` fallback). Endpoints can withhold data (a liveness concern)
  but **cannot forge it** — every fetched block is verified locally
  (Ed25519‑blake2b + balance‑chain derivation). Proof‑of‑work runs locally.
- **Off‑chain metadata & images:** stored off‑chain today (a known
  centralization point on the roadmap to content‑address).

The design's north star is a fully static, keyless app anyone can run from
public RPC — the direct‑settlement coins are already there.

---

## 7. Where to read the code

- `nano/core/state.ts` — the deterministic state machine (the trust model).
- `nano/core/oplink.ts`, `fraglink.ts` — op encoding into block links.
- `nano/indexer/` — reading Nano blocks, Lamport ordering, fixpoint replay.
- `nano/core/canonical.ts` — the state‑root fingerprint anyone recomputes.
- `nano/SPEC.md` — the full byte‑level spec and state‑machine reference.
- The **Explorer** in‑app ("Verify it yourself") re‑replays the ledger in your
  browser and compares roots with the server.

---

**TL;DR:** Nano can only send money. HodlGame turns that into a whole token
economy by putting each action in a signed block's `link` field and computing
the game as a **pure, deterministic replay** of those public blocks — so the AMM,
staking, and rewards are all *verifiable functions of the ledger* rather than
trusted server state. And for new coins, **nobody ever holds your money**: trades
settle wallet‑to‑wallet, collateral is checked by the ledger, and the creator
can't own more than 5%. The game rewards holding because quitters pay stayers.
No smart contracts required — just math anyone can re‑check.
