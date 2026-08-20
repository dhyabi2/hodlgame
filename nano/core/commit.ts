// Commit-reveal link for ops that don't fit the compact op-link (two amounts or
// a string payload): seedLiq, addLiq, transfer.
//
//   link = 0xFF ‖ blake2b(tokenId ‖ encodeOp(op))[0..30]
//
// The leading 0xFF marks a commit-reveal link so the indexer never confuses it
// with a compact op (opcodes live in 0x01..0x09). The full op is served
// off-chain; an indexer verifies it hashes back to the on-chain commitment.

import { blake2bHex } from "blakejs";
import { encodeOp } from "./encoding";
import type { Op } from "./ops";
import type { TokenId } from "./token";

export const COMMIT_OPCODE = 0xff;

/** 32-byte (64-hex) commit link embedding the tokenId and op. */
export function commitLink(tokenId: TokenId, op: Op): string {
  const payload = Buffer.concat([Buffer.from(tokenId, "hex"), encodeOp(op)]);
  const full = blake2bHex(payload, undefined, 32); // 64 hex = 32 bytes
  return "ff" + full.slice(0, 62); // 1 + 31 = 32 bytes
}

export function isCommitLink(link: string): boolean {
  return link.length >= 2 && link.slice(0, 2).toLowerCase() === "ff";
}

export function verifyCommit(tokenId: TokenId, op: Op, link: string): boolean {
  return commitLink(tokenId, op).toLowerCase() === link.toLowerCase();
}