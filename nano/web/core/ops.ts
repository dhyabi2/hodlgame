// HoldFun Nano L2 — operation types (the logical form; byte encoding is in SPEC.md §2)

export type Op =
  // `direct` marks a Direct-Settlement (zero-custody) token: no pool account
  // ever exists, buys pay queued sellers wallet-to-wallet or self-collateralize
  // (earmarks), and sells settle instantly against the seller's own earmark
  // with only realized appreciation queued against future buy flow.
  | { kind: "launch"; supply: bigint; name: string; symbol: string; decimals: number; image: string; direct?: boolean }
  | { kind: "transfer"; to: string; amount: bigint }
  // buy.xno is value-bound by the indexer (never declared) for pooled tokens
  // and for direct queue-routed buys; direct self-earmark buys declare xno in a
  // fragment link and are validity-checked against the signed block balance.
  // `depositTo` (attached by the indexer, direct tokens only) is the account
  // the chained deposit send paid — "" means self-collateralized (no deposit).
  // `balanceAt` is the op-carrier block's SIGNED balance (attached by the
  // indexer) — consensus input for the earmark-coverage check.
  | { kind: "buy"; xno: bigint; minTokens: bigint; depositTo?: string; balanceAt?: bigint }
  // sell.balanceAt: the exit block's signed balance — the actual-balance
  // netting cap that makes the flow-backed queue equal exactly unpaid
  // exit-realized appreciation (never phantom released-collateral claims).
  | { kind: "sell"; tokens: bigint; minXno: bigint; balanceAt?: bigint }
  | { kind: "stake"; amount: bigint }
  | { kind: "unstake"; amount: bigint }
  | { kind: "claim" }
  | { kind: "withdraw" }
  | { kind: "seedLiq"; xno: bigint; tokens: bigint }
  | { kind: "addLiq"; xno: bigint; tokens: bigint }
  // Futures (core/futures.ts): token-margined inverse positions. `side` 0=long
  // 1=short; `size` is notional in tokens; `margin` tokens are locked from the
  // sender's balance. futClose.size 0 = cancel all resting + close everything.
  // `guard` is the signer's entry-price bound (× PRECISION; 0 = none): long
  // fills only at entry ≤ guard, short only at entry ≥ guard. Required by the
  // fixpoint's deferral rule (SPEC §9) — it keeps a late-applied open inside
  // the price the signer actually accepted.
  | { kind: "futOpen"; side: 0 | 1; size: bigint; margin: bigint; guard: bigint }
  | { kind: "futClose"; size: bigint }
  // Synthetic observation (never encoded on-chain): the signed balance of one
  // account's block, folded in canonical order. Direct tokens use it to detect
  // earmark defection (balance dropped below the ratcheted floor) and void the
  // defector's position proportionally. No-op for pooled tokens.
  | { kind: "balance"; raw: bigint };

export const OP_CODE: Record<Exclude<Op["kind"], "balance">, number> = {
  launch: 0x01,
  transfer: 0x02,
  buy: 0x03,
  sell: 0x04,
  stake: 0x05,
  unstake: 0x06,
  claim: 0x07,
  withdraw: 0x0a,
  seedLiq: 0x08,
  addLiq: 0x09,
  futOpen: 0x0c,
  futClose: 0x0d,
};

// Direct-Settlement launch rides its own opcode so the mode is consensus-bound
// in the launch link itself (immutable, on-chain — like decimals).
export const OP_CODE_LAUNCH_DIRECT = 0x0b;
