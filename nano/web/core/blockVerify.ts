// Browser-safe block verification + amount derivation (no node deps — only
// nanocurrency). Shared by the server indexer (indexer/blockSource.ts) and the
// in-browser verifier (web/app/lib/clientIndexer.ts) so BOTH run byte-identical
// verification: a fetched block is trusted only if its signature verifies
// against the account the node attributes it to, and amount/subtype are DERIVED
// from the signed balance chain — never from the node's unsigned fields.

import * as nanocurrency from "nanocurrency";

export interface NanoBlock {
  account: string;
  hash: string;
  previous: string;
  link: string;
  representative: string;
  height: bigint;
  timestamp?: string;
  amount?: string; // DERIVED from signed balance delta
  subtype?: string; // DERIVED
  balance?: string; // signed, hash-covered
}

/** Raw blocks_info entry (+ hash) as returned by a Nano RPC. */
export interface RawFetchedBlock {
  hash: string;
  block_account: string;
  contents: any;
  height?: string;
  local_timestamp?: string;
}

/** Authenticity: genuine state block whose signature verifies against the
 * account the node attributes it to (binding closes owner-forgery). */
export function verifyFetchedBlock(
  hash: string,
  b: { block_account: string; contents: any; amount?: string }
): boolean {
  const c = b.contents ?? {};
  if (c.type && c.type !== "state") return false;
  try {
    const acct = String(c.account ?? "");
    if (!acct || acct.toLowerCase() !== String(b.block_account ?? "").toLowerCase()) return false;
    const computed = nanocurrency.hashBlock({
      account: acct,
      previous: c.previous,
      representative: c.representative,
      balance: c.balance,
      link: c.link,
    });
    if (computed.toLowerCase() !== hash.toLowerCase()) return false;
    const publicKey = nanocurrency.derivePublicKey(acct);
    return (nanocurrency as any).verifyBlock({
      hash: computed,
      signature: String(c.signature ?? "").toUpperCase(),
      publicKey,
    });
  } catch {
    return false;
  }
}

/** Native amount + subtype from SIGNED balances (balance/previous are
 * hash-covered), so a lying node cannot forge them. */
export function deriveAmountSubtype(
  balance: string,
  previous: string,
  prevBalance: bigint
): { amount: string; subtype: "send" | "receive" | "open" | "change" } {
  const bal = BigInt(balance);
  const isOpen = !previous || /^0+$/.test(previous);
  const prev = isOpen ? 0n : prevBalance;
  const delta = bal - prev;
  if (delta < 0n) return { amount: (-delta).toString(), subtype: "send" };
  if (delta > 0n) return { amount: delta.toString(), subtype: isOpen ? "open" : "receive" };
  return { amount: "0", subtype: isOpen ? "open" : "change" };
}

/** Turn raw fetched blocks for ONE account into verified NanoBlocks with
 * derived amount/subtype. Sig-failing blocks are dropped unless inert (no
 * balance change — the epoch carve-out), preserving `previous` linkage. */
export function finalizeChain(raw: RawFetchedBlock[]): NanoBlock[] {
  const staged = raw.map((b) => ({
    authentic: verifyFetchedBlock(b.hash, b),
    block: {
      account: b.block_account,
      hash: b.hash,
      previous: b.contents?.previous ?? "",
      link: b.contents?.link ?? "",
      representative: b.contents?.representative ?? "",
      height: BigInt(b.height ?? "0"),
      timestamp: b.local_timestamp,
      balance: b.contents?.balance,
    } as NanoBlock,
  }));
  staged.sort((a, b) => (a.block.height < b.block.height ? -1 : a.block.height > b.block.height ? 1 : 0));

  const balByHash = new Map<string, bigint>();
  const out: NanoBlock[] = [];
  for (const { authentic, block } of staged) {
    if (block.balance == null) continue;
    const isOpen = !block.previous || /^0+$/.test(block.previous);
    const prevBal = isOpen ? 0n : balByHash.get(block.previous);
    const derived =
      prevBal === undefined
        ? { amount: "0", subtype: "change" as const }
        : deriveAmountSubtype(block.balance, block.previous, prevBal);
    if (!authentic && derived.amount !== "0") continue; // forged value block → drop
    block.amount = derived.amount;
    block.subtype = derived.subtype;
    balByHash.set(block.hash, BigInt(block.balance));
    out.push(block);
  }
  return out;
}
