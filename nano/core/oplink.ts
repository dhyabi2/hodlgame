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
import { OP_CODE } from "./ops";
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

function writeAmount(buf: Uint8Array, offset: number, n: bigint) {
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
    case "buy": return op.xno;
    case "sell": return op.tokens;
    case "stake":
    case "unstake": return op.amount;
    case "claim": return 0n;
    default: throw new Error("op does not fit compact link: " + op.kind);
  }
}

/** Encode an op (scoped to `tokenId`) into a 32-byte (64-hex) link. */
export function encodeOpLink(tokenId: TokenId, op: Op): string {
  const buf = new Uint8Array(32);
  buf[0] = OP_CODE[op.kind];
  writeTokenId(buf, 1, op.kind === "launch" ? "" : tokenId);
  writeAmount(buf, 1 + TOKEN_ID_BYTES, primaryAmount(op));
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
      op = {
        kind: "launch",
        supply: amt,
        name: meta?.name ?? "",
        symbol: meta?.symbol ?? "",
        decimals: meta?.decimals ?? 6,
        image: meta?.image ?? "",
      };
      break;
    case OP_CODE.buy:
      op = { kind: "buy", xno: amt, minTokens: 0n };
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
    default:
      throw new Error("unknown op code " + code);
  }
  return { tokenId, op };
}
