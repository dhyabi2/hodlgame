# Security audit — break-the-validation pass (2026-08-21)

> **Scope note (Direct-Settlement v2, 2026-08-22):** findings touching pool
> custody, the sweep, and the guardian concern the **legacy pooled lane**
> (opcode `0x01`). v2 zero-custody tokens have no pool account and no custody
> path at all — see `../SPEC.md` §8.


Methodology: enumerate every security gate (validation, auth, signature,
value-binding, settlement, custody), assign one adversarial "breaker" per gate
that must actually reproduce an exploit with a runnable PoC (not describe one),
collect confirmed breaks, then fix each with a regression test. 10 breakers ran.

## Confirmed breaks and fixes

| # | Gate | Break | Severity | Fix |
|---|------|-------|----------|-----|
| 1 | `server/metaAuth.ts` | **Provisional-squat seq-DoS.** An attacker signs a not-yet-indexed token's metadata with `seq = MAX_SAFE_INTEGER`, permanently locking out the real creator (no larger seq exists) and branding the token. | High | Reject far-future seq (`> now + 5min`); when the on-chain creator overrides an unlocked provisional row, reset the seq floor to 0. |
| 2 | `core/metaAnchor.ts` | **Non-causal fold.** Per-account block height used as a global clock, so an authority who received control on a fresh low-height account could sell/transfer it and have the fold silently drop the transfer, keeping control. | Med-High | Walk the custody chain (creator → each authority's own-chain-ordered anchor) instead of a global height sort; cycle-guarded. |
| 3 | `indexer/blockSource.ts` (+ `sweep.ts`) | **RPC amount/subtype/account forgery** (found independently by 3 breakers). The node-supplied `amount`, `subtype`, and attributed `block_account` are NOT signed, so a malicious/degraded endpoint could inflate any token's `poolXno` (PoC: 1e29 phantom XNO → pool drain / consensus split), force a double-pay (absent `subtype`), or reattribute a valid block to a victim. | **Critical** | Bind the attributed account to the signed `account`; derive `amount`/`subtype` from the SIGNED balance chain (balance is hash-covered), never the node. `readPoolDepositsFromChain` derives pending-deposit amounts from the source send's own balance delta. |
| 4a | `web/app/api/rpc/route.ts` | **Rate-limit bypass.** Throttle keyed on client-controlled `x-forwarded-for` → rotate the header for a fresh bucket → unlimited `work_generate` (CPU/key burn) and `process`. | Med | Key on `x-real-ip` / the last (platform-appended) XFF hop; add IP-independent GLOBAL ceilings on the costly actions. |
| 4b | `cron/sweep/route.ts`, `server/server.ts` | **Fail-open auth.** Both sweep gates ran for anyone when their secret env var was unset. | Med-High | Fail closed: an unset secret rejects. |
| 5 | `server/guardian.ts` | **Guardian rubber-stamps.** It checked only balance>0 and pool-guarded, never the recipient or amount — a compromised operator could get a cosignature for a drain to any address; empty `GUARDED_POOLS` signed for any account. | High (custody path, W1) | Require `to`+`amountRaw`, derive `link` from `to`, independently verify against chain (`frontier` match, `onchain − amount == balance`), optional payout cap, and fail closed when unconfigured. |
| 6 | `server/custody.ts` | **Pool-seed hex-concat ambiguity.** `blake2b(master + tokenId as hex)` — non-hex or wrong-length inputs could collapse tokens to a shared key. Not reachable today (inputs always fixed hex) but a footgun. | Low | Derive from validated fixed-length BYTES (byte-identical for real inputs, so no pool migration). |

Cheap hardenings also applied: `safeUrl` strips embedded credentials;
`fraglink.writeAmt` throws on >120-bit/negative instead of silent truncation;
`collectEvents` marks each deposit consumed so one deposit can't back two ops
(defense against forked/replayed history).

## Gates that HELD (adversarially, with PoCs)

- **State machine** (`core/state.ts`): 49,607 fuzzed hostile ops — no supply
  inflation, over-cap creator share, negative balance, reward over-claim, AMM
  extraction, div-by-zero, or replay divergence.
- **HTTP validators** (`server/validate.ts`): no XSS via `safeUrl`, no
  `clampDecimals` DoS, no `isTokenId`/`isNanoAddress` false-accept (JS `$`
  ≠ PCRE), no prototype pollution in `sanitizeMeta`.
- **Op codecs** (`fraglink`/`oplink`/`encoding`/`commit`): 200k fuzzed links,
  marker spaces provably disjoint, no op-smuggling, no commit collision.
- **Comments** (`commentAuth`): unforgeable authorship, no digest collision,
  replay-idempotent ids.
- **Settlement/refunds** (`settled.ts`/`reconcile.ts`): no over-pay, phantom
  refund, or non-depositor drain (the only gap was the RPC `subtype` trust,
  closed by fix #3).
- **PoW validation** (`validateWork`): endianness/threshold correct; every RPC
  and workgen nonce validated locally before use.
- **API key isolation**: the key reaches rpc.nano.to only, never the fallback;
  whitelist/SSRF/upload paths held.
