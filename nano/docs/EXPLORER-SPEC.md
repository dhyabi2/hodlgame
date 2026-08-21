# HoldFun Explorer — full item list

Etherscan-parity mapped onto this stack, plus the trustless-native features a
contract-chain explorer cannot have. Grouped by page/layer; each item names
the data source that already exists (or the gap). "HARD" items get a
brainstormed design (see §Hard problems).

## A. Op layer (Etherscan: transactions)

- **A1. Global op feed** — latest ops across all tokens, newest first: kind
  badge (launch/buy/sell/stake/unstake/claim/seedLiq/addLiq/transfer),
  account, token, amounts, age, block hash. Source: `collectEvents` (exists);
  needs pagination (HARD H2).
- **A2. Op detail page** — the "tx page": raw Nano block(s) (fragment pairs
  and buy deposit+op shown as ONE logical op), byte-level link decode
  (opcode/tokenId/amounts annotated), signer, height, timestamp,
  confirmation status, and **state deltas** — every balance/pool/treasury/
  stake/reward field the op changed (Etherscan's internal transactions)
  (HARD H1). For rejected ops: the exact `InvalidOp` reason.
- **A3. Universal hash lookup** — paste any Nano block hash → classify it:
  compact op / fragment A/B / commit link (legacy) / buy deposit / seed
  deposit / pool payout / refund / anchor hello / pool hello / meta anchor /
  snapshot anchor / plain send. All decoders exist (`oplink`, `fraglink`,
  `commit`, `metaAnchor`, `anchor`); needs one classifier function + context
  linkage (which token, which op it funds).
- **A4. Value-flow story** — stitch multi-block flows into one view: deposit
  → buy → tokens out; sell → payout send; refund netting (HARD H4).
- **A5. Invalid-op explorer** — every rejected op with reason (slippage,
  unbacked seed, insufficient balance…). Source: `replayMulti` invalid list
  (exists, currently discarded per sync).

## B. Token layer (Etherscan: token pages)

- **B1. Token index** — all tokens: name/symbol/image, price, mcap, 24h
  change, holders, age, launch height. Source: `market.feed` (exists) + sort/
  filter/search.
- **B2. Token detail** — everything on one page:
  - supply breakdown: circulating / treasury / pool / staked / burned
    (burned = launch supply − current supply) — all in `State`;
  - **holders table** with %, paginated (exists top-N; full table HARD H2);
  - full per-token op history (HARD H2);
  - price + mcap charts (exists: `analyze` series);
  - pool panel: pool address, chain-derived pubkey, **proof-of-reserves**:
    indexer `poolXno` vs live pool account balance, with the difference
    explained (pending receives, unsettled obligations) — sources exist
    (`account_info`, `settled.ts`);
  - launch provenance: launch block hash, creator, height.
- **B3. Metadata provenance panel** — who signed the current metadata (seq,
  account), verified/provisional badge, immutable badge, authority history
  from on-chain anchors (`getMetaAnchors` + `deriveMetaAuthority` — exists),
  image CID + gateway links.
- **B4. Token lifecycle timeline** — launch → first seed → pool hello →
  authority events → notable trades. Derived from A-layer data.

## C. Account layer (Etherscan: address pages)

- **C1. Account page** — XNO balance (live RPC), per-token holdings/stakes/
  banked rewards (from `MultiState`), full op history across tokens (HARD
  H2), deposits made, payouts/refunds received, hello status, tokens
  created, tokens where this account is metadata authority.
- **C2. Known-address labels** — auto-label the anchor, every pool
  (pool→token from discovery), creator addresses; user-visible "Pool of
  TOKEN", "Protocol anchor". Sources exist.
- **C3. External links** — deep-link every account/block to public Nano
  explorers (nanexplorer.com, blocklattice.io) for the L1 view.

## D. Trust layer (beyond Etherscan — this chain can do what Ethereum can't)

- **D1. State root banner** — current consensus root (`stateRoot`, exists),
  last folded block, "how to verify" instructions.
- **D2. In-browser verification** — the killer feature: the visitor's
  browser recomputes state (or spot-checks a token/account) from public RPC
  and compares against the server's root — a green "verified by YOUR
  browser" badge (HARD H3).
- **D3. Proof-of-reserves dashboard** — all pools: indexer reserves vs
  on-chain balances, discrepancies flagged and explained.
- **D4. Settlement dashboard** — outstanding obligations per token
  (entitled − sent, from `settled.ts` — exists as pure functions), queued
  payouts, last sweep result/time.
- **D5. Discovery view** — anchor hello timeline, participant count over
  time, pool registry (pool → tokenId), WATCHED_ACCOUNTS-fallback status.
- **D6. Snapshot registry** — epoch snapshots: hash, size, anchored-on-chain
  status (`/api/snapshot` + `isAnchored` — exist), download + verify button.
- **D7. Custody status page** — per token: chain-derived pool == custody
  pool (the sweep's assert, surfaced); post-W1: signer set / threshold info.

## E. Cross-cutting

- **E1. Unified search** — one box: token name/symbol, 32-hex tokenId,
  nano_ address, 64-hex block hash → routed to the right page (A3 classifier
  powers the hash case).
- **E2. Explorer JSON API** — every page's data as documented endpoints
  (partially exists: `/api/state`, `/api/token`, `/root`, `/api/snapshot`);
  add `/api/ops`, `/api/op/<hash>`, `/api/account/<addr>`, `/api/holders/…`.
- **E3. Live updates** — poll or SSE on the feed pages (feed polling
  exists).
- **E4. Pagination + caching layer** — cursor pagination everywhere; the
  underlying incremental index is HARD H2.
- **E5. Raw-data affordances** — copy buttons, raw block JSON view, link
  byte-hexdump with colored field annotation (tokenId/amount/opcode).
- **E6. Empty/edge states** — pre-seed tokens (no pool yet), unindexed
  launches, tokens with mismatched (non-custody) pools — each with honest
  explanatory copy.

## Hard problems — brainstormed, evaluated, winning designs

Per problem: ~5 API-brainstormed candidates were evaluated against this
stack's constraints (serverless Vercel, deterministic replay, KV-only
storage, everything third-party-verifiable). Killed ideas noted with cause.

### H1. Per-op state deltas (the "internal transactions" panel)

Killed: SQLite on Vercel (no writable FS); Postgres delta tables (second
source of truth + infra); Merkle-proofed deltas (overkill until light
clients); background queues (serverless has no resident worker — cron is
the only queue and H2's cache already covers it).

**Winner — instrumented replay.** The state machine is pure and per-op
copies the touched token's maps already, so diffing is nearly free: add an
optional observer to `replayMulti` that, for each event, emits the touched
token's changed fields (balance moves per account, pool/treasury/supply/
stake/reward deltas) plus the `InvalidOp` reason for rejects. Deltas are
never STORED as truth — they re-derive deterministically from the (H2-
cached) event log on demand; for a single historical op, replay from the
nearest snapshot (H2) to that op. Verifiable by construction: any third
party re-running the replay gets byte-identical deltas.

### H2. Incremental indexing + pagination at scale

Killed: cron→Postgres SQL serving (a second, non-verifiable source of
truth; infra the project doesn't have); SQL views/ISR (same); anchor-as-
index (discovery ≠ content index); Merkle pagination (roadmap for proofs,
not needed to paginate honestly).

**Winner — frontier-keyed event-log cache, self-healing against the root.**
Persist to KV: (a) the decoded canonical event list (compact rows), (b) per-
account frontier hashes, (c) periodic full-state snapshots every N events.
Each sync: one batched `accounts_frontiers` call → refetch ONLY accounts
whose frontier moved (delta `account_history` from the stored head), append
newly decoded events, replay from the last snapshot. Pagination, holder
tables, and per-token/account histories read straight from the cached event
list. The cache is a COPY of chain data, not a source of truth: every sync
recomputes the state root; on mismatch the cache is dropped and rebuilt
from chain (self-healing), so determinism and third-party convergence are
preserved. Steady-state RPC cost: O(changed accounts), not O(world).

### H3. In-browser trustless verification

Killed: server-signed state roots (a signature by the party you distrust
adds nothing); server-proxied-only verification (meaningful against bugs,
worthless against a malicious server — allowed only as a labeled fallback).

**Winner — ship the indexer to the browser (it already almost runs there).**
`core/` and the state machine are browser-safe TS, and the web client
already uses them. A "Verify in your browser" button runs the real
pipeline client-side: anchor discovery → account fetch → decode → replay →
`stateRoot`, then compares against the server's `/root`. Chain data comes
from a user-selectable list of public CORS-enabled Nano RPCs (app proxy
only as an explicit reduced-trust fallback badge). At today's scale this is
seconds of work; as history grows, degrade gracefully: (a) spot modes —
verify one account's ops + one pool's reserves (`account_info` direct);
(b) checkpoint sync — start from the latest ANCHORED snapshot (D6) and
replay only blocks since, verifying the snapshot hash on-chain first.
Merkle inclusion proofs are the eventual light-client endgame; not needed
for v1.

### H4. Value-flow stitching (one legible story per economic event)

Killed: "cryptographic flow proofs" (cannot retrofit links into already-
signed blocks); time-proximity heuristics (fragile, non-deterministic).

**Winner — typed edges emitted by the pipeline that already knows.** Every
linkage the UI needs is already computed deterministically somewhere: buy
deposit ↔ op (`previous` chaining in `collectEvents`), fragment A ↔ B (the
join), seed deposit ↔ seedLiq, pool payout ↔ the obligations it covers
(reuse `settled.ts` netting: replay pool outgoing sends against the
canonical obligation queue POSITIONALLY — the same rule settlement uses to
avoid double-pay also attributes each payout send to the exact sells/
refunds it covered, including one send covering several). Extend decode/
replay to EMIT these edges as typed records `{from, to, kind}` alongside
events; the op page renders its connected component as the story
("deposit 0.001 → buy → 12,345 TOK", "payout covers sell #a1b2 + refund").
No storage beyond H2's cache; fully re-derivable.

## Build order

1. **E2 API skeleton + A3 classifier + E1 search** (pure assembly, unlocks
   everything).
2. **H2 event-log cache** (makes all history pages possible), then A1/B2
   history/holders/C1 account pages.
3. **H1 delta observer + A2 op page + H4 edges + A4 story view.**
4. **D-layer**: D1 root banner, D3 proof-of-reserves, D4 settlement, D5
   discovery, D6 snapshots (mostly existing data surfaced).
5. **H3 browser verification** (the differentiator; ship after pages are
   stable).
