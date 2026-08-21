// Fragment links — full op payload ON-CHAIN across two chained 1-raw blocks.
//
// Ops whose payload overflows one 32-byte link (transfer: to 32B + amount 15B;
// sell with minXno: two 15B amounts) used to ride a commit-reveal hash whose
// payload lived in an off-chain blob — lose the blob, rewrite the ledger.
// Fragments eliminate that dependency:
//
//   frag A (block N):   [ 0xE0|opcode: 1B ][ tokenId: 16B ][ body[0..15): 15B ]
//   frag B (block N+1): [ body[15..47): 32B ]      (B.previous === A.hash)
//
// The marker nibble 0xE is disjoint from compact opcodes (0x01..0x09) and the
// commit marker (0xFF). Frag B carries no marker — it is bound positionally
// (strictly chained, same account) and consumed by the indexer so its bytes
// are never mis-decoded as a standalone op. A dangling frag A (no valid B yet)
// is deterministically ignored by every replayer until B confirms.

import * as nanocurrency from "nanocurrency";
import type { Op } from "./ops";
import { OP_CODE } from "./ops";
import type { TokenId } from "./token";
import { TOKEN_ID_BYTES } from "./token";

const AMT_BYTES = 15;
const BODY_BYTES = 47; // 15 in frag A + 32 in frag B
export const FRAG_HIGH = 0xe0;

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
function writeAmt(buf: Uint8Array, offset: number, n: bigint) {
  // Fail loudly rather than silently truncating/wrapping a >120-bit or
  // negative amount into a wrong-but-valid link.
  if (n < 0n || n >= 1n << 120n) throw new Error("amount out of 120-bit range");
  for (let i = AMT_BYTES - 1; i >= 0; i--) {
    buf[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}
function readAmt(buf: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 0; i < AMT_BYTES; i++) n = (n << 8n) | BigInt(buf[offset + i]);
  return n;
}

function fragCode(kind: Op["kind"]): number | null {
  return kind === "transfer" ? OP_CODE.transfer : kind === "sell" ? OP_CODE.sell : null;
}

function bodyOf(op: Op): Uint8Array {
  const b = new Uint8Array(BODY_BYTES);
  if (op.kind === "transfer") {
    b.set(fromHex(nanocurrency.derivePublicKey(op.to)), 0); // 32B recipient pubkey
    writeAmt(b, 32, op.amount);
  } else if (op.kind === "sell") {
    writeAmt(b, 0, op.tokens);
    writeAmt(b, AMT_BYTES, op.minXno);
    // bytes 30..47 stay zero (verified on decode)
  } else {
    throw new Error("op does not use fragment links: " + op.kind);
  }
  return b;
}

/** Encode an op into its two fragment links [A, B] (64-hex each). */
export function encodeFragLinks(tokenId: TokenId, op: Op): [string, string] {
  const code = fragCode(op.kind);
  if (code == null) throw new Error("op does not use fragment links: " + op.kind);
  const body = bodyOf(op);
  const a = new Uint8Array(32);
  a[0] = FRAG_HIGH | code;
  a.set(fromHex(tokenId), 1);
  a.set(body.slice(0, 15), 1 + TOKEN_ID_BYTES);
  return [toHex(a), toHex(body.slice(15, BODY_BYTES))];
}

/** Is this link a fragment A? (Marker nibble + a known fraggable opcode.) */
export function isFragA(linkHex: string): boolean {
  if (linkHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(linkHex)) return false;
  const b0 = parseInt(linkHex.slice(0, 2), 16);
  if ((b0 & 0xf0) !== FRAG_HIGH) return false;
  const code = b0 & 0x0f;
  return code === OP_CODE.transfer || code === OP_CODE.sell;
}

/** Join frag A + frag B back into the op. Throws on any malformation —
 * callers treat a throw as "not a valid fragment pair" and skip. */
export function assembleFrag(aHex: string, bHex: string): { tokenId: TokenId; op: Op } {
  if (!isFragA(aHex)) throw new Error("not a fragment A link");
  if (bHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(bHex)) throw new Error("bad fragment B link");
  const a = fromHex(aHex);
  const code = a[0] & 0x0f;
  const tokenId = toHex(a.slice(1, 1 + TOKEN_ID_BYTES));
  const body = new Uint8Array(BODY_BYTES);
  body.set(a.slice(1 + TOKEN_ID_BYTES), 0);
  body.set(fromHex(bHex), 15);

  if (code === OP_CODE.transfer) {
    const toPub = toHex(body.slice(0, 32));
    if (/^0+$/.test(toPub)) throw new Error("transfer to zero pubkey");
    const to = nanocurrency.deriveAddress(toPub, { useNanoPrefix: true });
    return { tokenId, op: { kind: "transfer", to, amount: readAmt(body, 32) } };
  }
  // sell: trailing padding MUST be zero (rejects garbage that merely carries the marker)
  for (let i = 2 * AMT_BYTES; i < BODY_BYTES; i++) {
    if (body[i] !== 0) throw new Error("sell fragment padding not zero");
  }
  return { tokenId, op: { kind: "sell", tokens: readAmt(body, 0), minXno: readAmt(body, AMT_BYTES) } };
}
