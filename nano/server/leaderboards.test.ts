import { strict as assert } from "node:assert";
import { computeLeaderboards, creatorReputation } from "./leaderboards";
import type { TokenView } from "./market";

function tv(p: Partial<TokenView>): TokenView {
  return {
    tokenId: "t", name: "N", symbol: "S", decimals: 6, image: "", description: "",
    website: "", twitter: "", telegram: "", creator: "", creatorShare: "0",
    supply: "0", treasury: "0", poolXno: "0", poolTokens: "0", price: "0",
    marketCap: "0", change1h: null, change24h: null, createdAt: 0, myBalance: "0",
    myStaked: "0", myClaimable: "0", totalStaked: "0", buyVolume: "0", sellVolume: "0",
    holders: 0, pool: null, spark: [], series: [], trades: [], topHolders: [], comments: [],
    ...p,
  };
}

const XNO = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 24n).toString(); // n XNO in raw

const A = "nano_alice", B = "nano_bob";

const TOK = (n: number) => (BigInt(n) * 10n ** 6n).toString(); // n whole tokens, 6 decimals

const tokens: TokenView[] = [
  tv({ tokenId: "aa", symbol: "AAA", creator: A, poolXno: XNO(20), poolTokens: TOK(1000), buyVolume: XNO(30), sellVolume: XNO(20), holders: 40, change24h: 12, createdAt: 300, decimals: 6,
       topHolders: [{ account: "nano_h1", balanceRaw: TOK(5), pct: 50 }, { account: "nano_h2", balanceRaw: TOK(3), pct: 30 }] }),
  tv({ tokenId: "bb", symbol: "BBB", creator: A, poolXno: XNO(10), poolTokens: TOK(500), buyVolume: XNO(5), sellVolume: XNO(1), holders: 8, change24h: -4, createdAt: 400, decimals: 6,
       topHolders: [{ account: "nano_h1", balanceRaw: TOK(2), pct: 20 }] }),
  tv({ tokenId: "cc", symbol: "CCC", creator: B, poolXno: XNO(25), poolTokens: TOK(500), buyVolume: XNO(60), sellVolume: XNO(40), holders: 5, change24h: 80, createdAt: 500, decimals: 6, pool: "nano_poolcc",
       topHolders: [{ account: "nano_h2", balanceRaw: TOK(9), pct: 90 }, { account: "nano_poolcc", balanceRaw: TOK(100), pct: 0 }] }),
  // Zero-liquidity spam token: must NEVER appear on economic boards or inflate
  // its creator, even with a huge fake mark price and a dust-sybil holder crowd.
  tv({ tokenId: "dd", symbol: "SPAM", creator: "nano_attacker", poolXno: "0", poolTokens: "0", price: (10n ** 40n).toString(), holders: 9999, change24h: 999999, createdAt: 999, decimals: 6,
       topHolders: [{ account: "nano_attacker", balanceRaw: TOK(1_000_000), pct: 100 }] }),
];

const lb = computeLeaderboards(tokens, 123, 10);

// tokens: CCC has the most volume (100 XNO), AAA the most holders, CCC the top gainer, BBB newest? no — cc newest (500)
assert.equal(lb.tokens.byVolume[0].tokenId, "cc", "byVolume ranks CCC first");
assert.equal(lb.tokens.byHolders[0].tokenId, "aa", "byHolders ranks AAA first");
assert.equal(lb.tokens.byGainers[0].tokenId, "cc", "byGainers ranks CCC (+80%) first");
assert.equal(lb.tokens.newest[0].tokenId, "cc", "newest ranks the latest FUNDED launch first (spam dd excluded)");

// creators: A launched 2 tokens with 48 holders; B launched 1 with 5. A should win + get Community + Serial? (count 2 < 3 so no Serial)
assert.equal(lb.creators[0].account, A, "creator A ranks first (more holders/tokens)");
assert.equal(lb.creators[0].tokenCount, 2);
assert.equal(lb.creators[0].holders, 48);
assert.ok(lb.creators[0].badges.includes("Community"), "A earns Community badge (>=25 holders)");
assert.ok(!lb.creators[0].badges.includes("Serial"), "A has only 2 tokens, no Serial badge");
assert.ok(lb.creators.find((c) => c.account === A)!.badges.includes("Blue chip"), "A holds the most real pooled liquidity");

// ── manipulation resistance: the zero-liquidity SPAM token is inert ──────────
assert.ok(!lb.tokens.byVolume.some((t) => t.tokenId === "dd"), "zero-liq token cannot reach the volume board");
assert.ok(!lb.tokens.byGainers.some((t) => t.tokenId === "dd"), "a +999999% pump on an empty pool cannot reach gainers");
assert.ok(!lb.tokens.byHolders.some((t) => t.tokenId === "dd"), "9999 dust-sybil holders cannot reach the holders board");
assert.ok(!lb.tokens.newest.some((t) => t.tokenId === "dd"), "an unseeded spam token cannot occupy the New board");
assert.ok(!lb.creators.some((c) => c.account === "nano_attacker"), "spam creator earns no reputation");
assert.ok(!lb.holders.some((h) => h.account === "nano_attacker"), "fake mark price redeems to ~0, so no whale rank");

// determinism: recompute → identical
assert.deepEqual(computeLeaderboards(tokens, 123, 10), lb, "recompute is byte-identical (deterministic)");

// holders: pool account excluded; h2 (9 in CCC + 3 in AAA) tops the value board
assert.ok(!lb.holders.some((h) => h.account === "nano_poolcc"), "pool account is never ranked as a holder");
assert.equal(lb.holders[0].account, "nano_h2", "h2 has the most aggregate holdings value");
assert.ok(lb.holders[0].badges.includes("Whale"), "top holder gets the Whale badge");

// creatorReputation scopes to one account
assert.equal(creatorReputation(tokens, B)!.tokenCount, 1);
assert.equal(creatorReputation(tokens, "nano_nobody"), null);

console.log("✅ leaderboards derivation tests passed");
