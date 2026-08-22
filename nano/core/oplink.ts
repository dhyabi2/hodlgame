// Multi-token 32-byte link codec. Every op rides in a Nano block's `link` field:
//
//   [ opcode: 1B ][ tokenId: 16B ][ amount: 15B ]
//
// `tokenId` is the 128-bit launch-hash prefix (see token.ts). `launch` is the
// origin block — its `link` carries no tokenId (that slot is zero); the tokenId
// is derived from the launch block's hash *after* it is signed/broadcast.
//
// Compact ops carry a single amount. Slippage guards (buy.minTokens /
// sell.minXno) are therefore not representable here and decode to 0 — reserved
// for the commit-reveal path.

import type { Op } from "./ops";
import { OP_CODE, OP_CODE_LAUNCH_DIRECT } from "./ops";
import type { TokenId } from "./token";
import { TOKEN_ID_BYTES } from "./token";

const AMT_BYTES = 15;

const HEX = "0123456789abcdef";
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const AMT_MAX = (1n << BigInt(AMT_BYTES * 8)) - 1n; // 15 bytes → 2^120 - 1

function writeAmount(buf: Uint8Array, offset: number, n: bigint) {
  // Fail loudly rather than silently wrap: an amount that doesn't fit the field
  // (e.g. a supply larger than 2^120-1) would otherwise be truncated mod 2^120
  // and encode as a DIFFERENT value than intended.
  if (n < 0n || n > AMT_MAX) throw new Error(`amount ${n} does not fit the ${AMT_BYTES}-byte link field`);
  for (let i = AMT_BYTES - 1; i >= 0; i--) {
    buf[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}
function readAmount(buf: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 0; i < AMT_BYTES; i++) n = (n << 8n) | BigInt(buf[offset + i]);
  return n;
}
function writeTokenId(buf: Uint8Array, offset: number, tokenId: TokenId) {
  const raw = fromHex(tokenId || "0".repeat(TOKEN_ID_BYTES * 2));
  buf.set(raw, offset);
}
function readTokenId(buf: Uint8Array, offset: number): TokenId {
  return toHex(buf.slice(offset, offset + TOKEN_ID_BYTES));
}

function primaryAmount(op: Op): bigint {
  switch (op.kind) {
    case "launch": return op.supply;
    case "buy": return op.minTokens; // xno is bound by the chained deposit, not here
    case "sell": return op.tokens;
    case "stake":
    case "unstake": return op.amount;
    case "claim": return 0n;
    case "withdraw": return 0n;
    case "seedLiq":
    case "addLiq": return op.tokens; // xno is bound by the chained pool deposit
    case "balance": throw new Error("balance is a synthetic observation, never encoded");
    default: throw new Error("op does not fit compact link: " + op.kind);
  }
}

/** Encode an op (scoped to `tokenId`) into a 32-byte (64-hex) link. */
export function encodeOpLink(tokenId: TokenId, op: Op): string {
  const buf = new Uint8Array(32);
  if (op.kind === "balance") throw new Error("balance is a synthetic observation, never encoded");
  buf[0] = op.kind === "launch" && op.direct ? OP_CODE_LAUNCH_DIRECT : OP_CODE[op.kind];
  writeTokenId(buf, 1, op.kind === "launch" ? "" : tokenId);
  writeAmount(buf, 1 + TOKEN_ID_BYTES, primaryAmount(op));
  // Bind decimals ON-CHAIN for launch (the launch link's tokenId slot is
  // otherwise all-zero — tokenId comes from the block hash). Stored as
  // decimals+1 in byte 1 so 0 stays "legacy/unset" (pre-this-change launches),
  // distinct from a real 0-decimals token. This makes decimals immutable and
  // part of consensus — exchanges can pin it. Range 0..18 (see clampDecimals).
  if (op.kind === "launch") {
    const d = op.decimals;
    if (Number.isInteger(d) && d >= 0 && d <= 18) buf[1] = d + 1;
  }
  return toHex(buf);
}

export interface DecodedLink {
  tokenId: TokenId;
  op: Op;
}

/**
 * Decode a 32-byte link. `meta` fills launch metadata (name/symbol/etc) that
 * the compact form cannot carry.
 */
export function decodeOpLink(
  hex: string,
  meta?: { name: string; symbol: string; decimals: number; image: string }
): DecodedLink {
  const buf = fromHex(hex);
  if (buf.length !== 32) throw new Error("compact link must be 32 bytes");
  const code = buf[0];
  const tokenId = readTokenId(buf, 1);
  const amt = readAmount(buf, 1 + TOKEN_ID_BYTES);
  let op: Op;
  switch (code) {
    case OP_CODE.launch:
    case OP_CODE_LAUNCH_DIRECT: {
      // Decimals are consensus-bound in byte 1 (decimals+1; 0 = legacy → fall
      // back to off-chain meta, else 6). New tokens carry immutable decimals.
      const dByte = buf[1];
      const decimals = dByte === 0 ? meta?.decimals ?? 6 : dByte - 1;
      op = {
        kind: "launch",
        supply: amt,
        name: meta?.name ?? "",
        symbol: meta?.symbol ?? "",
        decimals,
        image: meta?.image ?? "",
        ...(code === OP_CODE_LAUNCH_DIRECT ? { direct: true } : {}),
      };
      break;
    }
    case OP_CODE.buy:
      op = { kind: "buy", xno: 0n, minTokens: amt };
      break;
    case OP_CODE.sell:
      op = { kind: "sell", tokens: amt, minXno: 0n };
      break;
    case OP_CODE.stake:
      op = { kind: "stake", amount: amt };
      break;
    case OP_CODE.unstake:
      op = { kind: "unstake", amount: amt };
      break;
    case OP_CODE.claim:
      op = { kind: "claim" };
      break;
    case OP_CODE.withdraw:
      op = { kind: "withdraw" };
      break;
    case OP_CODE.seedLiq:
      op = { kind: "seedLiq", xno: 0n, tokens: amt }; // xno bound by chained deposit
      break;
    case OP_CODE.addLiq:
      op = { kind: "addLiq", xno: 0n, tokens: amt };
      break;
    default:
      throw new Error("unknown op code " + code);
  }
  return { tokenId, op };
}
