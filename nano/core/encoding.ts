// HoldFun Nano L2 — logical op encoding + on-chain commitment.
//
// `encodeOp`/`decodeOp` give the canonical bytes an indexer replays.
// `opCommitment` is blake2b-256 of those bytes — the 32-byte value that goes in
// a Nano block's `link` field (commit-reveal: the full op is served by any
// indexer, who verifies it hashes back to the on-chain commitment).

import { blake2bHex } from "blakejs";
import type { Op } from "./ops";
import { OP_CODE } from "./ops";

function u16(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(n >> 64n, 0);
  b.writeBigUInt64BE(n & 0xffffffffffffffffn, 8);
  return b;
}
function r16(b: Buffer, o: number): { n: bigint; o: number } {
  const hi = b.readBigUInt64BE(o);
  const lo = b.readBigUInt64BE(o + 8);
  return { n: (hi << 64n) | lo, o: o + 16 };
}
function rStr(b: Buffer, o: number): { s: string; o: number } {
  const len = b.readUInt8(o);
  return { s: b.slice(o + 1, o + 1 + len).toString("utf8"), o: o + 1 + len };
}

export function encodeOp(op: Op): Buffer {
  const parts: Buffer[] = [Buffer.from([OP_CODE[op.kind]])];
  const w16 = (n: bigint) => parts.push(u16(n));
  const wstr = (s: string) => {
    const buf = Buffer.from(s, "utf8");
    parts.push(Buffer.from([buf.length]), buf);
  };

  switch (op.kind) {
    case "launch":
      w16(op.supply); wstr(op.name); wstr(op.symbol); parts.push(Buffer.from([op.decimals])); wstr(op.image);
      break;
    case "transfer":
      wstr(op.to); w16(op.amount);
      break;
    case "buy":
      w16(op.xno); w16(op.minTokens);
      break;
    case "sell":
      w16(op.tokens); w16(op.minXno);
      break;
    case "stake":
    case "unstake":
      w16(op.amount);
      break;
    case "claim":
      break;
    case "seedLiq":
    case "addLiq":
      w16(op.xno); w16(op.tokens);
      break;
  }
  return Buffer.concat(parts);
}

export function decodeOp(buf: Buffer): Op {
  const code = buf.readUInt8(0);
  let o = 1;
  const rd16 = () => {
    const r = r16(buf, o);
    o = r.o;
    return r.n;
  };
  const rdstr = () => {
    const r = rStr(buf, o);
    o = r.o;
    return r.s;
  };

  switch (code) {
    case OP_CODE.launch: {
      const supply = rd16();
      const name = rdstr();
      const symbol = rdstr();
      const decimals = buf.readUInt8(o);
      o += 1;
      const image = rdstr();
      return { kind: "launch", supply, name, symbol, decimals, image };
    }
    case OP_CODE.transfer:
      return { kind: "transfer", to: rdstr(), amount: rd16() };
    case OP_CODE.buy:
      return { kind: "buy", xno: rd16(), minTokens: rd16() };
    case OP_CODE.sell:
      return { kind: "sell", tokens: rd16(), minXno: rd16() };
    case OP_CODE.stake:
      return { kind: "stake", amount: rd16() };
    case OP_CODE.unstake:
      return { kind: "unstake", amount: rd16() };
    case OP_CODE.claim:
      return { kind: "claim" };
    case OP_CODE.seedLiq:
      return { kind: "seedLiq", xno: rd16(), tokens: rd16() };
    case OP_CODE.addLiq:
      return { kind: "addLiq", xno: rd16(), tokens: rd16() };
    default:
      throw new Error("unknown op code " + code);
  }
}

/** 32-byte hex blake2b-256 commitment — what goes in the Nano `link` field. */
export function opCommitment(op: Op): string {
  return blake2bHex(Buffer.from(encodeOp(op)), null, 32);
}
