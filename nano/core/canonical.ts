// Canonical serialization + state root for the multi-token ledger.
//
// The root covers CONSENSUS fields only — balances, stakes, supply, pool
// reserves, heights — and deliberately excludes off-chain cosmetics
// (name/symbol/decimals/image come from the metadata registry), so two
// verifiers with different metadata mirrors still agree on the root.
// Deterministic: sorted keys everywhere, bigints as decimal strings.

import { blake2bHex } from "blakejs";
import type { MultiState } from "./multi";
import type { State } from "./state";
import { futuresActive } from "./futures";

export function canonicalize(v: unknown): string {
  if (typeof v === "bigint") return `"${v.toString()}"`;
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (v instanceof Map) {
    const entries = [...v.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(String(k))}:${canonicalize(val)}`).join(",")}}`;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const keys = Object.keys(v)
    .filter((k) => (v as any)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((v as any)[k])}`).join(",")}}`;
}

/** Project a token State onto its consensus fields (drop off-chain meta). */
function consensusView(s: State) {
  return {
    launched: s.launched,
    supply: s.supply,
    creator: s.creator,
    creatorShare: s.creatorShare,
    balances: s.balances,
    staked: s.staked,
    banked: s.banked,
    rewardDebt: s.rewardDebt,
    totalStaked: s.totalStaked,
    rewardPerShare: s.rewardPerShare,
    rebateVault: s.rebateVault,
    treasury: s.treasury,
    poolXno: s.poolXno,
    poolTokens: s.poolTokens,
    xnoCredit: s.xnoCredit,
    xnoWithdrawn: s.xnoWithdrawn,
    direct: s.direct,
    earmark: s.earmark,
    earmarkFloor: s.earmarkFloor,
    queue: s.queue.map((e) => ({ account: e.account, owed: e.owed })),
    prepaid: s.prepaid,
    // Present ONLY once a token has futures activity, so every pre-futures
    // root (all anchored history) is byte-identical to before the feature.
    futures: futuresActive(s.futures)
      ? {
          book: s.futures.book.map((o) => ({ id: o.id, account: o.account, side: o.side, size: o.size, margin: o.margin })),
          pairs: s.futures.pairs.map((p) => ({
            id: p.id,
            size: p.size,
            entry: p.entry,
            long: { account: p.long.account, margin: p.long.margin },
            short: { account: p.short.account, margin: p.short.margin },
          })),
          nextId: s.futures.nextId,
          samples: s.futures.samples.map((x) => ({ t: x.t, price: x.price })),
          settled: s.futures.settled.map((x) => ({ ...x })),
        }
      : undefined,
    height: s.height,
  };
}

/** blake2b-256 root of the full multi-token consensus state (64 hex). */
export function stateRoot(state: MultiState): string {
  const projected = new Map<string, unknown>();
  for (const [tokenId, s] of state) projected.set(tokenId, consensusView(s));
  return blake2bHex(new TextEncoder().encode(canonicalize(projected)), undefined, 32);
}
