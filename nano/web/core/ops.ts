// HoldFun Nano L2 — operation types (the logical form; byte encoding is in SPEC.md §2)

export type Op =
  | { kind: "launch"; supply: bigint; name: string; symbol: string; decimals: number; image: string }
  | { kind: "transfer"; to: string; amount: bigint }
  | { kind: "buy"; xno: bigint; minTokens: bigint }
  | { kind: "sell"; tokens: bigint; minXno: bigint }
  | { kind: "stake"; amount: bigint }
  | { kind: "unstake"; amount: bigint }
  | { kind: "claim" }
  | { kind: "withdraw" }
  | { kind: "seedLiq"; xno: bigint; tokens: bigint }
  | { kind: "addLiq"; xno: bigint; tokens: bigint };

export const OP_CODE: Record<Op["kind"], number> = {
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
};
