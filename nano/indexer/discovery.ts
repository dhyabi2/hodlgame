// Trustless participant discovery (roadmap W7).
//
// The watched set is a pure function of chain data reachable from the public
// ANCHOR account (core/anchor.ts): hop 1 collects everyone who transacted
// with the anchor (hellos in, bootstrap sends out), partitioning pool hellos
// (representative encodes a tokenId) from user hellos; hop 2 adds every
// counterparty of each pool (buyers/sellers who predate the hello scheme).
// Deterministic and convergent for any indexer; terminates in exactly 2 hops
// because op links decode to opcodes, never to further accounts.
//
// A bogus pool hello (spam tokenId) costs one extra account scan and can
// never affect state — ops are still signature/deposit-validated on replay.

import type { CounterpartyReader } from "./blockSource";
import { tokenIdFromHelloRep } from "../core/anchor";

export interface DiscoveredSet {
  users: string[]; // accounts to replay ops from, sorted
  pools: Map<string, string>; // pool account → claimed tokenId (from its hello rep)
}

export async function discoverAccounts(reader: CounterpartyReader, anchor: string): Promise<DiscoveredSet> {
  const { inbound, outbound } = await reader.counterparties(anchor);

  const users = new Set<string>(outbound); // anchor bootstrap sends name legacy accounts
  const pools = new Map<string, string>();
  for (const h of inbound) {
    const tokenId = tokenIdFromHelloRep(h.representative);
    if (tokenId) pools.set(h.sender, tokenId);
    else users.add(h.sender);
  }

  for (const pool of [...pools.keys()].sort()) {
    const cp = await reader.counterparties(pool);
    for (const h of cp.inbound) users.add(h.sender);
    for (const a of cp.outbound) users.add(a);
  }

  users.delete(anchor);
  for (const p of pools.keys()) users.delete(p); // pool chains carry no ops
  return { users: [...users].sort(), pools };
}
