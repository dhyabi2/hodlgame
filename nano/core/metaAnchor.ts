// On-chain anchors for the two metadata-authority actions that a lost store
// cannot reconstruct from signatures alone (roadmap W4 residue):
//
//   makeImmutable — one 1-raw send:  link = [0xEE][tokenId:16B][15 zero bytes]
//   setAuthority  — two chained 1-raw sends (fragment-style):
//       A: link = [0xEA][tokenId:16B][newAuthorityPub[0..15)]
//       B: link = [newAuthorityPub[15..32)][15 zero bytes]     (B.previous = A)
//
// Anchors are broadcast by the CURRENT authority's own account, so validity
// is chain-checkable: an anchor from anyone else is ignored. Authority state
// per token is then a pure fold over anchors in canonical order, seeded by
// the launch creator — a successor with an empty database recovers who owns
// each token's metadata and which tokens are frozen, from chain data alone.
//
// Marker bytes 0xEE/0xEA are disjoint from compact opcodes (0x01..0x09),
// fragment markers (0xE2/0xE4), and the commit marker (0xFF). The zero
// padding is enforced on decode, so a stray 1-raw send to a pubkey that
// merely starts with the marker byte almost never parses — and even then it
// is ignored unless its sender is the token's current authority.

import * as nanocurrency from "nanocurrency";
import type { TokenId } from "./token";
import { TOKEN_ID_BYTES } from "./token";

export const IMMUTABLE_MARKER = 0xee;
export const SET_AUTHORITY_MARKER = 0xea;

export interface MetaAnchor {
  tokenId: TokenId;
  kind: "immutable" | "setAuthority";
  newAuthority?: string; // nano_ address (setAuthority only)
  sender: string;
  height: bigint; // completing block's height (B for pairs)
  hash: string; // completing block's hash
}

export interface MetaAuthorityState {
  authority: string; // current authority (nano_ address)
  immutable: boolean;
}

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

/** The single anchor link freezing a token's metadata forever. */
export function immutableAnchorLink(tokenId: TokenId): string {
  const buf = new Uint8Array(32);
  buf[0] = IMMUTABLE_MARKER;
  buf.set(fromHex(tokenId), 1);
  return toHex(buf);
}

/** The chained pair [A, B] transferring metadata authority. */
export function setAuthorityAnchorLinks(tokenId: TokenId, newAuthority: string): [string, string] {
  const pub = fromHex(nanocurrency.derivePublicKey(newAuthority));
  const a = new Uint8Array(32);
  a[0] = SET_AUTHORITY_MARKER;
  a.set(fromHex(tokenId), 1);
  a.set(pub.slice(0, 15), 1 + TOKEN_ID_BYTES);
  const b = new Uint8Array(32);
  b.set(pub.slice(15, 32), 0); // 17 bytes; the remaining 15 stay zero
  return [toHex(a), toHex(b)];
}

export function isImmutableAnchor(linkHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(linkHex)) return false;
  if (parseInt(linkHex.slice(0, 2), 16) !== IMMUTABLE_MARKER) return false;
  return /^0{30}$/.test(linkHex.slice(34)); // enforced zero padding
}

export function isSetAuthorityAnchorA(linkHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(linkHex) && parseInt(linkHex.slice(0, 2), 16) === SET_AUTHORITY_MARKER;
}

export function tokenIdOfAnchor(linkHex: string): TokenId {
  return linkHex.slice(2, 2 + TOKEN_ID_BYTES * 2).toLowerCase();
}

/** Join a setAuthority pair back to the new authority address. Throws on any
 * malformation (callers skip). */
export function assembleSetAuthority(aHex: string, bHex: string): { tokenId: TokenId; newAuthority: string } {
  if (!isSetAuthorityAnchorA(aHex)) throw new Error("not a setAuthority anchor A");
  if (!/^[0-9a-fA-F]{64}$/.test(bHex)) throw new Error("bad anchor B link");
  if (!/^0{30}$/.test(bHex.slice(34))) throw new Error("anchor B padding not zero");
  const pub = aHex.slice(34) + bHex.slice(0, 34);
  if (/^0+$/.test(pub)) throw new Error("zero authority pubkey");
  return {
    tokenId: tokenIdOfAnchor(aHex),
    newAuthority: nanocurrency.deriveAddress(pub.toLowerCase(), { useNanoPrefix: true }),
  };
}

/**
 * Fold anchors into per-token authority state, seeded by each token's launch
 * creator. The fold walks the CHAIN OF CUSTODY, not a global clock: `height`
 * is per-account, so sorting all anchors by (height, hash) is NOT causal — an
 * authority who received control on a fresh (low-height) account could have
 * their own outgoing transfer sorted before the grant and silently dropped,
 * letting them renege after selling control. Instead we start at the creator
 * and, at each step, apply that authority's FIRST anchor by their OWN chain
 * height, then follow it: setAuthority moves control to the named account,
 * makeImmutable freezes one-way. A per-token visited set stops cycles
 * (A→B→A). Deterministic and causal for every indexer.
 */
export function deriveMetaAuthority(
  anchors: MetaAnchor[],
  creators: Map<string, string>
): Map<string, MetaAuthorityState> {
  // tokenId → sender → anchors, each sender's list in own-chain order.
  const byToken = new Map<string, Map<string, MetaAnchor[]>>();
  for (const a of anchors) {
    const bySender = byToken.get(a.tokenId) ?? new Map<string, MetaAnchor[]>();
    const list = bySender.get(a.sender) ?? [];
    list.push(a);
    bySender.set(a.sender, list);
    byToken.set(a.tokenId, bySender);
  }
  const chainOrder = (x: MetaAnchor, y: MetaAnchor) =>
    x.height !== y.height ? (x.height < y.height ? -1 : 1) : x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0;

  const out = new Map<string, MetaAuthorityState>();
  for (const [tokenId, creator] of creators) {
    const bySender = byToken.get(tokenId);
    let authority = creator;
    let immutable = false;
    const visited = new Set<string>();
    while (bySender && !visited.has(authority)) {
      visited.add(authority);
      const list = bySender.get(authority);
      if (!list || list.length === 0) break;
      // The authority's effective action is their EARLIEST anchor for this token.
      const first = [...list].sort(chainOrder)[0];
      if (first.kind === "immutable") {
        immutable = true;
        break;
      }
      if (first.kind === "setAuthority" && first.newAuthority) {
        authority = first.newAuthority;
        continue;
      }
      break;
    }
    out.set(tokenId, { authority, immutable });
  }
  return out;
}
