# Proposal: HodlGame Static — a serverless launchpad + DEX in one HTML page

**Status:** parked — future consideration only, not scheduled for implementation (owner decision 2026-08-25) · **Scope:** separate project/repo · **Author:** drafted 2026-08-25

## 1. One-paragraph summary

Anyone should be able to run their own HodlGame-style launchpad and DEX by
forking a repository that contains **one `index.html`, one `app.js`, and one
`config.js`**, editing the config (RPC endpoint, anchor account, branding), and
publishing it on any static host — GitHub Pages, IPFS, Cloudflare Pages, a USB
stick. No backend, no database, no operator key, no custody. This is possible
because the protocol is already *trustless by construction*: every action is a
signed block on the public Nano ledger, the market state is a deterministic
replay of those blocks, zero-custody (Direct-Settlement) tokens need no pool
account, and the public Nano RPC endpoints allow browser (CORS) access. The
current `hodlgame.fun` app already contains a browser-side verifier that
recomputes the entire state from chain data — the template is that verifier
promoted to *the* application, plus a wallet.

## 2. Why this is feasible today (verified against code and live endpoints)

| Requirement | Today | Evidence |
|---|---|---|
| Replay market state in the browser | **Exists** | `web/app/lib/clientIndexer.ts` runs discovery → fetch → verify → replay → state root using the same `core/` + `indexer/` code as the server |
| Discover all coins and participants without a server | **Exists** | `indexer/discovery.ts`: deterministic 2-hop walk from the public anchor account (hellos in, pools' counterparties) |
| Verify fetched blocks without trusting the RPC | **Exists** | `core/blockVerify.ts`: ed25519-blake2b signature checks; an RPC can omit data, never forge it |
| Browser → Nano network | **Works** | `rpc.nano.to` and `rpc.nano-gpt.com` both answer `Access-Control-Allow-Origin: *`; `wss://ws.nano.to` works from browsers |
| No custody / no operator secrets | **Exists** for zero-custody tokens (opcode `0x0b`) | No pool account, no sweep cron, no FROST; buys pay queued sellers wallet-to-wallet or self-collateralize |
| Deterministic, era-safe consensus | **Exists** | Canonical order + fixpoint replay; era constants (`TIME_ORDER_ERA`, `FULL_REBATE_ERA`) are published code constants every replayer shares |
| Proof-of-work in the browser | **Solvable** | `nanocurrency` ships `computeWork` (WASM); optional RPC key gives instant server PoW |
| Coin name / symbol / image | **Gap** | Stored off-chain in the operator's signed registry; only `supply` + `decimals` are in the on-chain launch link |

The single real gap is metadata (§5). Everything else is packaging.

## 3. Goals and non-goals

**Goals**
- A fork-and-deploy template: `index.html` + `app.js` + `config.js` (+ optional
  `assets/`). Zero runtime dependencies on any HodlGame server.
- Full user flows for zero-custody coins: browse, chart, buy, sell, stake,
  unstake, claim, transfer, send/receive XNO, launch a coin, set its price.
- Trustless by default: state is computed locally from chain data the page
  fetched and signature-verified itself.
- Interoperable: a coin launched from any template deployment is the same coin
  on `hodlgame.fun` and on every other deployment (same anchor, same protocol).
- Cheap to run: an ecosystem of hundreds of accounts syncs in seconds on a
  phone, incrementally after first load.

**Non-goals (v1)**
- The legacy pooled-custody lane (opcode `0x01`, FROST, sweeps). Excluded; the
  template lists those coins read-only if they exist, never trades them.
- Comments, referrals, share-cards, leaderboards that need a server. (Local,
  derived leaderboards are fine.)
- Multi-anchor federation. One anchor account per deployment (configurable).

## 4. Architecture

```
┌──────────────────── static host (any) ────────────────────┐
│ index.html   app.js (bundle)   config.js   assets/        │
└───────────────────────────┬───────────────────────────────┘
                            │ HTTPS + WSS (CORS *)
          ┌─────────────────┼──────────────────┐
          ▼                 ▼                  ▼
   Nano RPC (reads,    Nano websocket     IPFS gateway(s)
   process, optional   (confirmations →   (coin metadata JSON
   work_generate)      notifications)     + images by CID)
```

**Layers inside `app.js`** (all from the existing codebase unless noted):

1. **Protocol core** — `core/` (state machine, multi-token router, canonical
   order, fragment links, anchors, block verification). Unchanged; vendored.
2. **Indexer** — `indexer/` (discovery, block source, multi-indexer, fixpoint
   replay). Unchanged except a browser `BlockSource` that calls the RPC
   directly (today's `clientIndexer.ts` goes through `/api/rpc`; the template
   talks to the endpoint in `config.js`).
3. **Persistence** — *new*: an IndexedDB implementation of the existing
   `SharedBlockCache` interface (frontier-keyed, monotonic). First visit does
   the full walk; later visits fetch only accounts whose frontier moved.
4. **Wallet + trading** — `web/app/lib/trade.ts` (quotes, block building,
   buy/sell/stake/claim/transfer, XNO send/receive) with its `rpc()` and
   `work_generate` calls parametrized. Seed encrypted in the browser exactly as
   today (`web/app/lib/wallet.ts`, PBKDF2 + AES-GCM).
5. **Proof-of-work** — *new*: layered exactly like the server's policy —
   `work_generate` via RPC when a key is configured → `nanocurrency.computeWork`
   (WASM, in a Web Worker so the UI stays responsive) otherwise. Receive
   difficulty is cheap; send difficulty takes seconds to tens of seconds in
   WASM — acceptable for a keyless hobby deployment, and the config makes the
   upgrade a one-liner.
6. **Metadata** — *new* (§5): on-chain CID anchor → JSON on IPFS.
7. **UI** — *new, small*: plain DOM + a few hundred lines of vanilla TS (no
   framework), monochrome like the current app. Views: coins list, coin page
   (chart, trades, holders, trade form, stake panel), wallet (balance,
   send/receive, history, notifications bell), create coin.

**Build**: `esbuild` bundles TypeScript + `nanocurrency` + `blakejs` + the WASM
(inlined as base64) into one `app.js` (~600 KB–1 MB gzipped ≈ 250 KB). The
repo ships the built `app.js` so non-developers never run a build.

## 5. The protocol extension: on-chain coin metadata (CID anchor)

Today a launch's name/symbol/image live in the operator's signed registry. A
serverless page needs them on-chain. Proposed addition, mirroring the existing
`setAuthority` anchor (`core/metaAnchor.ts`) — two chained 1-raw sends from the
token's current metadata authority (the creator, unless transferred):

```
A: link = [0xEC][tokenId:16B][cid[0..15)]
B: link = [cid[15..32)][15 zero bytes]        (B.previous = A)
```

- `cid` is the 32-byte SHA-256 multihash digest of a CIDv0 (`Qm…`) pointing to
  a JSON document `{ "name", "symbol", "image", "description"?, "links"? }`.
  `image` is itself an `ipfs://CID`. The page resolves both through the
  gateway list in `config.js` (with fallbacks), verifies the fetched bytes
  hash to the CID, and caches them in IndexedDB.
- **Authority-checked, like every anchor**: only the current authority's
  anchor counts; latest valid anchor wins; `makeImmutable` freezes it. A
  successor indexer with an empty database recovers every coin's metadata from
  chain data alone — which is the whole point.
- **Cost**: 2 raw + 2 PoW. Pinning: the deployer configures any pinning
  service (web3.storage, Pinata, a self-hosted node); the JSON is tiny and the
  image is whatever the creator uploads. A coin whose pin lapses still trades —
  the page falls back to `tokenId` display, exactly as `hodlgame.fun` does
  today for unnamed coins.
- **Marker byte `0xEC`** is disjoint from compact opcodes (`0x01..0x0b`),
  fragment markers (`0xE2/0xE4`), anchors (`0xEE/0xEA`), and the commit marker
  (`0xFF`).
- **Rollout on hodlgame.fun**: additive and era-safe — no existing state
  changes. The create-coin flow broadcasts the anchor after launch; the
  registry remains as a cache and for legacy coins. Backfill: the operator can
  broadcast anchors for existing coins whose metadata authority it holds, or
  creators can re-anchor themselves. Until then, the template shows those
  coins by `tokenId`.

This should land in the main app first (small PR: encode/decode + indexer fold
+ create-flow broadcast + tests), so both ecosystems read the same metadata.

## 6. Trust model of a template deployment

- **State**: computed locally from signature-verified blocks. The RPC can hide
  blocks (the page would see a stale/partial world) but cannot forge trades,
  balances, or ownership. Two endpoints are configured (primary + fallback) so
  a single omission is noticed on the next sync.
- **Ordering**: timestamps are node-reported, not signed (documented in
  `SPEC.md §9`). Same trust as today's app: a hostile RPC could reorder
  same-second concurrency, never move funds. The IndexedDB cache pins
  first-seen chains so a deployment's served history only refines forward.
- **Keys**: never leave the browser. No page code can spend without the user's
  password-unlocked seed in memory.
- **Metadata**: content-addressed (CID) and authority-anchored on-chain; a
  gateway can fail to serve, never substitute.
- **No admin**: there is nothing a deployer can do to users' funds or coins.
  The deployer is a *publisher of a UI*, not an operator.

## 7. Configuration surface (`config.js`)

```js
window.HODL_CONFIG = {
  name: "My Launchpad",                 // branding
  anchor: "nano_31tg1ui9…",             // protocol anchor (default: HodlGame's)
  rpc: ["https://rpc.nano.to", "https://rpc.nano-gpt.com"],
  rpcKey: "",                           // optional: enables server PoW + higher limits
  ws: "wss://ws.nano.to",
  ipfsGateways: ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"],
  pinning: { provider: "none" | "web3storage" | "pinata", token: "" }, // for launches
  theme: { accent: "#ffffff" },
  showLegacyPooled: false,              // list custody-lane coins read-only
};
```

Changing the anchor creates an independent ecosystem (own coins, own
discovery); keeping the default joins HodlGame's.

## 8. Performance plan

- **First load**: discovery (2 RPC calls) + one `blocks_info`/`account_history`
  per account. Today's ecosystem (~25 accounts, ~1,200 events) replays in
  well under a second once fetched; fetching is the cost — sequential and
  rate-limit-aware like `clientIndexer.ts` (one in-flight request), ~1–3 s on a
  keyless endpoint.
- **Later loads**: frontier check per account (batched `accounts_frontiers`
  when the endpoint supports it), fetch only moved chains, fold incrementally.
- **Ceiling**: the design is O(accounts). Beyond a few thousand active
  accounts a deployment would want a published snapshot (the existing epoch
  snapshot format, §`server/snapshot.ts`) as a *verifiable* starting point —
  a phase-5 item, not needed for launch.

## 9. Phases and deliverables

| Phase | Deliverable | Est. effort |
|---|---|---|
| 0 · Metadata anchor in main app | `0xEC` CID anchor: encode/decode, indexer fold, authority rules, create-flow broadcast, tests, SPEC §; era-safe deploy | 1 day |
| 1 · Read-only DEX | Repo scaffold, esbuild bundle, direct-RPC block source, IndexedDB cache, coins list, coin page (chart/trades/holders), metadata via CID | 1–2 days |
| 2 · Wallet + trading | Seed wallet, XNO send/receive/history, notifications, buy/sell/stake/unstake/claim/transfer for zero-custody coins, browser PoW worker + RPC-key fast path | 2 days |
| 3 · Launch | Create coin (launch + virtual-liquidity price), metadata JSON + image pinning via configured provider, CID anchor broadcast | 1 day |
| 4 · Template polish | `config.js` surface, branding, "fork → edit → deploy" README, GitHub Pages workflow, IPFS publish script, i18n hooks | 1 day |
| 5 · (later) Scale | Verifiable snapshot bootstrap, multi-gateway metadata, PWA offline shell | — |

Each phase ends deployed on a public static host as a live demo joined to the
HodlGame anchor, so interoperability is proven continuously rather than at the
end.

## 10. Repository layout (separate project)

```
hodl-static/
  index.html            # the page (no build needed to deploy)
  app.js                # built bundle (committed)
  config.js             # deployer edits this
  assets/               # icon, og image
  src/
    ui/                 # vanilla TS views
    net/rpc.ts          # endpoint rotation, CORS fetch, rate gate
    net/ws.ts           # confirmations → notifications
    store/idb.ts        # IndexedDB SharedBlockCache
    pow/worker.ts       # computeWork in a Web Worker
    meta/cid.ts         # CID anchor decode + gateway fetch + hash check
  protocol/             # vendored core/ + indexer/ + client trade lib
  scripts/sync-protocol.sh   # copies from the main repo at a pinned commit
  scripts/build.sh      # esbuild → app.js
  README.md             # fork → edit config → deploy
```

The protocol code is vendored at a **pinned main-repo commit** (recorded in
`protocol/VERSION`) so a template deployment's consensus rules are explicit
and auditable; upgrades are a deliberate re-sync.

## 11. Risks and mitigations

- **RPC rate limits / bans** (real: the keyless tier bans aggressive IPs).
  Mitigation: single in-flight request, IndexedDB cache, frontier-only
  re-sync, endpoint rotation, and a clear "add your own key" path.
- **Browser PoW UX** on slow phones: run in a worker with a progress
  indicator; precompute the next block's work in the background after each
  confirmed block (the frontier is known), so the *next* action feels instant.
- **Metadata pin rot**: content-addressed, so it can be re-pinned by anyone;
  UI degrades to `tokenId` never to wrong data.
- **Consensus drift between deployments**: pinned protocol version + published
  era constants; a `state root` badge lets any two deployments compare.
- **Legacy pooled coins**: shown read-only with a notice, never traded.

## 12. Open questions for the owner

1. Confirm the metadata direction: on-chain CID anchor (recommended) vs.
   templates reading `hodlgame.fun`'s registry API (simpler, but a server
   dependency).
2. Default anchor: should templates join HodlGame's ecosystem by default
   (recommended: shared liquidity/discovery) or start isolated?
3. Pinning provider defaults for launches (web3.storage vs. Pinata vs. none —
   "none" means creators paste an existing `ipfs://` link).
4. Licensing of the template (MIT suggested, matching the main repo).

## 13. Definition of done (v1)

- A fresh fork with only `config.js` edited deploys to GitHub Pages and shows
  the live HodlGame market, computed and signature-verified in the browser.
- A user can create a wallet, receive XNO, buy/sell/stake a zero-custody coin,
  and see it reflected on `hodlgame.fun` — and vice-versa.
- A coin launched from the template appears with name/symbol/image on
  `hodlgame.fun` via the on-chain CID anchor.
- Zero requests to any HodlGame-operated server (verifiable in the browser's
  network tab).
