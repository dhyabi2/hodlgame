// Compact 32-byte op encoding: fits an op + up to two 15-byte amounts into the
// Nano block `link` field directly (no hashing, no commit-reveal). This is what
// the v1 indexer decodes from on-chain blocks.
//
// Uint8Array-based so it works in both Node and the browser.

import type { Op } from "./ops";
import { OP_CODE } from "./ops";

const AMT_BYTES = 15; // 120 bits — covers XNO raw (10^30) and token amounts

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

/** Encode an op into a 32-byte hex string (throws if the op doesn't fit). */
export function encodeOpCompact(op: Op): string {
  const buf = new Uint8Array(32);
  buf[0] = OP_CODE[op.kind];
  switch (op.kind) {
    case "launch":
      writeAmount(buf, 1, op.supply);
      break;
    case "buy":
      writeAmount(buf, 1, op.xno);
      writeAmount(buf, 1 + AMT_BYTES, op.minTokens);
      break;
    case "sell":
      writeAmount(buf, 1, op.tokens);
      writeAmount(buf, 1 + AMT_BYTES, op.minXno);
      break;
    case "stake":
    case "unstake":
      writeAmount(buf, 1, op.amount);
      break;
    case "claim":
      break;
    case "seedLiq":
    case "addLiq":
      writeAmount(buf, 1, op.xno);
      writeAmount(buf, 1 + AMT_BYTES, op.tokens);
      break;
    default:
      throw new Error("op does not fit compact encoding: " + op.kind);
  }
  return toHex(buf);
}

/** Decode a 32-byte link back into an op. `meta` fills the launch metadata. */
export function decodeOpCompact(
  hex: string,
  meta?: { name: string; symbol: string; decimals: number; image: string }
): Op {
  const buf = fromHex(hex);
  if (buf.length !== 32) throw new Error("compact link must be 32 bytes");
  const code = buf[0];
  switch (code) {
    case OP_CODE.launch:
      return {
        kind: "launch",
        supply: readAmount(buf, 1),
        name: meta?.name ?? "",
        symbol: meta?.symbol ?? "",
        decimals: meta?.decimals ?? 6,
        image: meta?.image ?? "",
      };
    case OP_CODE.buy:
      return { kind: "buy", xno: readAmount(buf, 1), minTokens: readAmount(buf, 1 + AMT_BYTES) };
    case OP_CODE.sell:
      return { kind: "sell", tokens: readAmount(buf, 1), minXno: readAmount(buf, 1 + AMT_BYTES) };
    case OP_CODE.stake:
      return { kind: "stake", amount: readAmount(buf, 1) };
    case OP_CODE.unstake:
      return { kind: "unstake", amount: readAmount(buf, 1) };
    case OP_CODE.claim:
      return { kind: "claim" };
    case OP_CODE.seedLiq:
      return { kind: "seedLiq", xno: readAmount(buf, 1), tokens: readAmount(buf, 1 + AMT_BYTES) };
    case OP_CODE.addLiq:
      return { kind: "addLiq", xno: readAmount(buf, 1), tokens: readAmount(buf, 1 + AMT_BYTES) };
    default:
      throw new Error("unknown op code " + code);
  }
}
