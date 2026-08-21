# Trustless Continuity Roadmap

> **Status (2026-08-21):** SHIPPED — W2 (chain-derived settlement), W3
> (fragment links), W5 (ipfs:// images), W7 (anchor discovery), W8
> (chain-derived pools + verify CLI), W9 (RPC failover + local block
> verification), W10 (dissolved by W2/W4), plus signed comments, LICENSE,
> and CI with vendored-drift gate from W6. REMAINING — W1 custody
> (needs steward selection), W4 residue (makeImmutable/setAuthority on-chain
> anchors), W6 org/second-owner steps (account owner only). Epoch snapshot
> anchoring + Shamir seed tooling shipped as zero-risk custody prep.
>
> **W1 revision (2026-08-21 audit of ~/verifyXNOPrivacyProtocol):** the
> founder's BlackBird/VELA project already runs a PRODUCTION blake2b-FROST
> **2-of-3** for Nano pool custody — dealerless DKG, ceremony CLI, verifying
> cosigners (each recomputes the block hash, checks its own ledger view, and
> refuses non-whitelisted block shapes), and a journaled single-key→threshold
> migration (`scripts/migrate_pool.py`, `docs/FROST_MIGRATION.md`). This
> collapses the ladder: skip Layer 1 (musig-nano 2-of-2) entirely and lift
> BlackBird's `frost/src/suite.rs` ciphersuite + DKG/sign CLI + coordinator
> orchestration for the endgame directly. The key adoption beyond threshold
> signing itself: **cosigner-as-verifier** — HoldFun's second signer must
> re-derive expected payouts from its own indexer replay before releasing a
> share (settlement is already deterministic, so this check is cheap).

Goal: HoldFun keeps working if the founder — or any single person, secret, or
company account — disappears. Each section is one finding from the continuity
audit, the candidate fixes that were brainstormed and evaluated, the winning
design, and what trust remains afterwards. Build order is at the end.

Method: per finding, ~5 candidate mechanisms were generated (brainstorm API),
then adversarially evaluated against this stack's real constraints (Nano has no
contracts, one 32-byte link per block, ONE ed25519-blake2b signature per block,
deterministic indexer replay). Broken ideas are recorded with the reason they
died, so successors don't re-walk dead ends.

---

## W1. Pool custody (POOL_SEED single point of failure)

**Finding.** One master seed HD-derives every pool account. Lost → all funds
frozen; leaked → all drained; unrotatable. The existing "2-of-3" guardian path
emits a `signatures` array that **no Nano node accepts** (blocks carry exactly
one signature) — and the pool key alone can sign anyway, so it enforced nothing.

**Killed ideas.** Native 3-of-5 multisig blocks (don't exist on Nano);
time-locked client refunds (Nano has no timelocks; a send is irrevocable);
"public derivation with no secret" (spend keys must exist somewhere — the
useful kernel is separating *address announcement* from *key custody*).

**Research ground truth.** musig-nano (used by Nault) produces one valid
aggregate signature today but is **N-of-N only** and unaudited. FROST (RFC
9591) with a custom BLAKE2b-512 ciphersuite would give true t-of-n — feasible
(nodes only check the blake2b Schnorr equation) but it's novel, unbuilt,
unaudited crypto. Shamir/SLIP-39 seed splitting is mature but reconstructs the
key on one machine at signing time.

**Winning design — a 3-layer ladder:**

- **Layer 0 (ship now, no new crypto).** Per-token independent pool seeds
  (kill the master seed). HOT/COLD split: deposits land at the announced pool
  address held by an online hot sweeper key; every sweep skims balance above a
  **hot cap** — `max(24h trailing payout volume × 1.5, 5 XNO)`, ceiling 5% of
  token TVL — to a cold account whose seed exists only as SLIP-39 2-of-3
  shares across independent stewards. Top-ups are air-gapped ceremonies
  (monthly, or when queued payouts > 12h), and every ceremony rotates the cold
  key. Delete the fake `signatures` path; repurpose guardian.ts as a policy
  approver (operational control) until Layer 1.
- **Layer 1 (~4–8 weeks).** Hot pool accounts become musig-nano **2-of-2**
  aggregates (operator daemon + guardian daemon). MuSig's 3 interactive rounds
  are 3 HTTP round-trips between always-on daemons — compatible with the
  per-minute sweep. The guardian independently re-derives each payout from its
  own indexer replay before co-signing. N-of-N liveness risk is mitigated by
  SLIP-39-backing each party's key for succession.
- **Layer 2 (roadmap, 4–6 months + audit).** blake2b-FROST ciphersuite over
  frost-core → true 2-of-3 / 3-of-5 signer daemons; ceremonies die. Do not
  ship before external audit.

**Rotation.** A pool announces its successor with a block signed by the
*current* pool key naming the new address; the chain-derived resolver (W8)
switches at that height. Migrating off POOL_SEED: create new keys per token →
announce → sweep the whole old balance over → destroy the master seed.

**Residual trust.** L0: hot key (bounded by cap), 2-of-3 steward collusion.
L1: both daemons compromised = hot drained. L2: t-of-n collusion only.

## W2. Settlement liveness (the founder's cron is the heartbeat)

**Finding.** Buys/payouts/refunds run from one Vercel cron on a personal paid
account. Also discovered during evaluation: running N sweepers concurrently
today **double-pays** — the `paid`/`refunded` dedup ledgers are per-operator,
so each operator refunds the full owed amount.

**Killed ideas.** Fee-incentivized relayers (can't settle without the pool
key; no trustless fee mechanism without contracts); user-driven settlement
(every settlement block is pool-signed; users can only rebroadcast); bonded
slashing (no contracts → no enforceable bond; theater).

**Winning design — deterministic chain-derived settlement.** Delete the three
private ledgers. Derive everything from the pool's own chain: deposits from
receive blocks (`link` = source send → sender/amount via block_info);
already-settled from replaying the pool's outgoing sends against a **canonical
obligation queue** (sell payouts in event order, then refunds by sender).
All settlers construct the *identical* next block — same hash — so duplicate
`process` calls are no-ops and exactly-once is free. Any k threshold signers
(W1) online = the heartbeat; N independent watchtowers are safe by
construction. Bonus: this retires the durable-store dependency that is broken
in prod today.

**Residual trust.** RPC honesty (mitigate per W9); with single-key custody,
every settler holds the key — real permissionlessness arrives with W1 L1+.

## W3. Commit-reveal blob (off-chain payloads the ledger depends on)

**Finding.** Two-amount ops live on-chain only as 31-byte hashes; payloads sit
in one JSON blob capped at 5000 entries. Lose it → replay silently rewrites.

**Killed ideas.** Hash-chaining payloads (turns silent corruption into
permanent halt — fail-stop without recovery); deriving amounts from nonces
(user-chosen values can't be derived); sequence anchors (detects gaps, can't
fill them); Merkle roots (integrity was never the problem; availability is).

**Winning design — put the payload on-chain via 2-block fragment links.**
Value-binding already freed seedLiq/addLiq from the commit path (deposit
amount is authoritative; `tokens` fits a compact link). Only `transfer`
(63B) and `sell.minXno` (30B) still need two links:
Frag A `[0xE0|opcode][tokenId 16B][body 0..15]`, Frag B (chained,
`previous = A.hash`) `[body 15..47]`. Indexer joins strictly-chained pairs;
a dangling frag A is deterministically ignored until B confirms. Marker
nibble 0xE is disjoint from opcodes 0x01–0x09 and commit 0xFF. History:
snapshot the current blob into a checked-in `genesis/commits.json` — every
entry self-verifies against its on-chain link, so it's data availability, not
trust. Then retire the write path.

**Residual trust: zero from cutover** — replay needs only account chains.
~450–500 line diff.

## W4. Off-chain store (metadata, comments, refund ledger)

**Finding.** One operator KV store; losing/forking it corrupts payouts and
identity. (Prod's store is currently unconfigured — writes already fail.)

**Killed ideas.** Anchoring every payload on-chain (operator-signed anchors
prove only what the operator anchored); metadata/comments as on-chain blocks
(PoW per comment is hostile and unnecessary — signatures already make mirrors
verifiable).

**Winning design — the chain is the ledger; the store is a cache.**
`deposits`/`paid`/`refunded` become chain-derived (W2's netting: pay
`max(0, entitlement − already-sent)` per recipient — misses underpay-then-
retry, never double-pay). Comments get domain-separated user signatures
(`holdfun-comment-v1`, same pattern as metaAuth) so any mirror serves them
verifiably. Two rare irrecoverable authority actions — `makeImmutable`,
`setAuthority` — each get one 1-raw anchor send from the authority account so
authority state is chain-derivable even from an empty store. The residue
(commit reveals until W3 lands, signed meta-update log, signed comments) is
snapshotted per epoch to IPFS with the snapshot hash anchored on-chain.

**Boot-from-nothing:** custody handoff → scan anchor account (W7) for the
token set → fetch latest snapshot from any mirror, verify hash on-chain →
replay indexer → scan pool chains → netting sweep. Nobody double-paid.

## W5. Token images (personal Pinata account)

**Killed ideas.** On-chain data URIs (a Nano block has one free 32-byte field
— dead); Handshake/Unstoppable domains (adds a resolution trust layer CIDs
already solve); GitHub Pages registry (a second fork of truth; keep only its
re-pin script).

**Winning design.** Store `ipfs://CID` instead of gateway URLs (upload route:
~5 lines; validator already accepts `ipfs:`). Client renders via a gateway
list with `onError` fallback and the existing initials-avatar as last resort
(also fixes a latent bug: `ipfs://` URLs currently pass validation but render
broken). Publish a ~20-line community re-pin script (enumerate CIDs from the
public metadata feed → `ipfs pin add`) — availability becomes permissionless.
Optional Arweave mirror (~$0.05 per 5MB image) as belt-and-suspenders.
Migration: rewrite `https://*/ipfs/CID` rows to `ipfs://CID` (client handles
unmigrated rows anyway). ~100 lines total.

## W6. Code governance (one personal GitHub account, no license)

**Killed ideas.** Bit-reproducible Next.js builds (build IDs/timestamps make
the promise unkeepable, and the app deploys from source — pin *source*, not
binaries); "3-of-5 GPG multisig admin" (GitHub has no multisig admin — the
real equivalent is an org with 2–3 owners + branch protection incl. admins +
signed commits/tags); client-side indexer blacklisting (circular: shipped by
the maintainer it checks).

**Winning ladder by leverage.**
1. **LICENSE (Apache-2.0) — ~10 minutes.** Without it nobody may legally fork
   or continue. Everything else is moot until this lands.
2. GitHub org + 2–3 owners, hardware-key 2FA, branch/tag protection.
3. Public CI: run the nano test suite **and fail on `nano/*` vs `nano/web/*`
   vendored drift** (a diff loop) — drift means audited code ≠ deployed code.
4. Signed tags (Sigstore/SSH) + `SIGNERS.md`; expose the deployed commit SHA
   at `/api/health` — attestation, not proof, and say so.
5. Self-host docs. **Honest limit:** a hosted web wallet can never be
   trustless — the server picks the JS each visitor gets. Trustlessness ends
   at a client the user runs from source; document that path.

## W7. Participant discovery (WATCHED_ACCOUNTS env)

**Killed ideas.** Full-ledger scans (no public RPC iterates 200M+ blocks;
viable only on a self-hosted node — keep as audit path); per-user pool
derivation (pools are per-token); HTTP claim endpoints (non-deterministic
across indexers, free spam sink — the claim must be on-chain).

**Winning design — the anchor account.** One hardcoded public `ANCHOR`
address in core/. Every account sends 1 raw to it before its first op; every
pool self-registers at creation with `representative = tokenId` (public
pool→token binding without revealing keys). Discovery = 2 fixed hops:
ANCHOR's counterparties → partition into pools (tokenId rep, cross-checked
against a real launch) and users → pool counterparties add legacy users →
sync. Deterministic (pure function of chain data), terminates, converges for
every indexer. Spam costs an attacker a funded account + PoW per entry and is
amortized by frontier-hash caching; batched `accounts_frontiers` makes
steady-state cost *lower* than today. Migration: the operator anchor-hellos
all current accounts and pools once, then `WATCHED_ACCOUNTS` is deleted.

## W8. Verifiable market state (private replay inputs)

**Killed ideas.** Indexer quorum (colluding quorum still lies; once inputs
are public, one person replaying beats N agreeing); operator-signed state
roots as truth (kept only as convenience pointers — replay is truth).

**Winning design — chain-derived pool resolver + verify CLI.** The key fact:
every seed deposit's `link` *is* the pool pubkey — pool addresses are already
public chain data. Two-pass resolution: pass 1 scans creator-signed seedLiq
ops and records `poolKey(T) := first valid seed deposit's link` (first-wins in
canonical order); pass 2 is today's collectEvents using that map. **Zero
migration** — pass 1 reproduces today's derived pubkeys exactly. The sweep
asserts chain-derived == custody-derived and refuses mismatched tokens (a
creator seeding to a self-controlled "pool" gets a UI flag and no custody
service). Add `core/canonical.ts` (canonical JSON + blake2b state root),
extend `/state` to return `{root, lastHash, accounts, state}`, publish roots
periodically on-chain, and ship `npm run verify`: recompute state from chain
with zero secrets and diff against any serving indexer. ~340 lines.

## W9. Chain access (one hardcoded paid RPC vendor)

**Killed ideas.** On-chain RPC registries (a config file with extra steps and
a new trust root); IPFS ledger hashes (Nano has no canonical global ledger
hash; who signs the snapshot?); building an archive federation (the community
node ecosystem already exists — consume it).

**Winning design.** `NANO_RPC_URLS` ordered list (nano.to → SomeNano →
rainstorm.city → localhost) with per-call failover and circuit breakers; key
sent only to nano.to. **Verify blocks locally** — `nanocurrency` already
ships `hashBlock`/`verifyBlock`: check hash, signature, and chain contiguity
on everything fetched, so any untrusted endpoint becomes usable for reads
(2-of-3 quorum rejected: integrity is self-certifying; quorum only helps
omission and *hurts* liveness). Work: endpoint `work_generate` → local
`computeWork` fallback → optional `NANO_WORK_URL` (nano-work-server).
Document the self-hosted non-voting node (8GB RAM / 4-core / ~100GB ledger,
400GB headroom) as the sovereign path. ~250–400 lines ×2 copies.

## W10. Prod persistence gap (known Upstash issue)

Mostly **dissolved by W2/W4**: once deposits/paid/refunded are chain-derived
and the residue is epoch-snapshotted, the store is a cache — configure
Upstash for convenience, not correctness.

---

## Build order

**Phase 1 — days (paperwork + cheap wins).** LICENSE, org + owners, CI +
vendored-drift gate, push everything; `ipfs://` images + re-pin script;
signed comments.

**Phase 2 — weeks (make replay fully public).** W8 chain-derived resolver +
verify CLI → W7 anchor discovery → W9 RPC failover + local verification →
W3 fragment links + genesis snapshot → W2 chain-derived settlement.
After Phase 2, *anyone* can compute, serve, and verify the entire market from
chain data alone.

**Phase 3 — weeks (custody L0).** Per-token seeds, hot/cold split + caps,
SLIP-39 ceremonies, guardian-as-policy-approver, pool rotation/announcement.

**Phase 4 — months (custody L1→L2).** musig-nano 2-of-2 hot custody;
blake2b-FROST t-of-n as the audited endgame.

**End-state residual trust** (stated plainly): the hosted UI can serve
malicious JS (escape hatch: self-host, documented); configured RPC endpoints
can omit data (escape hatch: self-hosted node); hot-wallet balances up to the
cap ride on 2 daemons until FROST lands. Everything else — ledger truth,
settlement correctness, metadata authority, discovery, history — requires
trusting no one.
