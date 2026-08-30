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

// Fraggable two-amount ops. buy carries (xno, minTokens) so a Direct-Settlement
// self-earmark buy can DECLARE its xno with no deposit block (validity checks
// it against the signed block balance); seedLiq/addLiq carry (xno, tokens) so a
// direct token's creator can seed VIRTUAL reserves with no pool deposit.
function fragCode(kind: Op["kind"]): number | null {
  switch (kind) {
    case "transfer": return OP_CODE.transfer;
    case "sell": return OP_CODE.sell;
    case "buy": return OP_CODE.buy;
    case "seedLiq": return OP_CODE.seedLiq;
    case "addLiq": return OP_CODE.addLiq;
    case "futOpen": return OP_CODE.futOpen;
    default: return null;
  }
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
  } else if (op.kind === "buy") {
    writeAmt(b, 0, op.xno);
    writeAmt(b, AMT_BYTES, op.minTokens);
  } else if (op.kind === "seedLiq" || op.kind === "addLiq") {
    writeAmt(b, 0, op.xno);
    writeAmt(b, AMT_BYTES, op.tokens);
  } else if (op.kind === "futOpen") {
    // [ size: 15B ][ margin: 15B ][ side: 1B ][ guard: 15B ][ zero: 1B ]
    writeAmt(b, 0, op.size);
    writeAmt(b, AMT_BYTES, op.margin);
    // Fail loudly rather than silently truncating an out-of-range side into a
    // valid-looking byte (every other field already rejects out-of-range).
    if (op.side !== 0 && op.side !== 1) throw new Error("futures side must be 0 or 1");
    b[2 * AMT_BYTES] = op.side;
    writeAmt(b, 2 * AMT_BYTES + 1, op.guard);
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
  return (
    code === OP_CODE.transfer ||
    code === OP_CODE.sell ||
    code === OP_CODE.buy ||
    code === OP_CODE.seedLiq ||
    code === OP_CODE.addLiq ||
    code === OP_CODE.futOpen
  );
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
  if (code === OP_CODE.futOpen) {
    const sideByte = body[2 * AMT_BYTES];
    if (sideByte !== 0 && sideByte !== 1) throw new Error("bad futures side");
    for (let i = 3 * AMT_BYTES + 1; i < BODY_BYTES; i++) {
      if (body[i] !== 0) throw new Error("fragment padding not zero");
    }
    return {
      tokenId,
      op: {
        kind: "futOpen",
        side: sideByte as 0 | 1,
        size: readAmt(body, 0),
        margin: readAmt(body, AMT_BYTES),
        guard: readAmt(body, 2 * AMT_BYTES + 1),
      },
    };
  }
  // two-amount ops: trailing padding MUST be zero (rejects garbage that merely
  // carries the marker)
  for (let i = 2 * AMT_BYTES; i < BODY_BYTES; i++) {
    if (body[i] !== 0) throw new Error("fragment padding not zero");
  }
  const a0 = readAmt(body, 0);
  const a1 = readAmt(body, AMT_BYTES);
  if (code === OP_CODE.sell) return { tokenId, op: { kind: "sell", tokens: a0, minXno: a1 } };
  if (code === OP_CODE.buy) return { tokenId, op: { kind: "buy", xno: a0, minTokens: a1 } };
  if (code === OP_CODE.seedLiq) return { tokenId, op: { kind: "seedLiq", xno: a0, tokens: a1 } };
  if (code === OP_CODE.addLiq) return { tokenId, op: { kind: "addLiq", xno: a0, tokens: a1 } };
  throw new Error("unknown fragment opcode");
}
