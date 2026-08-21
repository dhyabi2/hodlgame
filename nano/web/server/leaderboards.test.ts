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

const tokens: TokenView[] = [
  tv({ tokenId: "aa", symbol: "AAA", creator: A, marketCap: XNO(100), buyVolume: XNO(30), sellVolume: XNO(20), holders: 40, change24h: 12, createdAt: 300,
       price: (10n ** 30n).toString(), decimals: 6,
       topHolders: [{ account: "nano_h1", balanceRaw: (5n * 10n ** 6n).toString(), pct: 50 }, { account: "nano_h2", balanceRaw: (3n * 10n ** 6n).toString(), pct: 30 }] }),
  tv({ tokenId: "bb", symbol: "BBB", creator: A, marketCap: XNO(10), buyVolume: XNO(5), sellVolume: XNO(1), holders: 8, change24h: -4, createdAt: 400,
       price: (10n ** 30n).toString(), decimals: 6,
       topHolders: [{ account: "nano_h1", balanceRaw: (2n * 10n ** 6n).toString(), pct: 20 }] }),
  tv({ tokenId: "cc", symbol: "CCC", creator: B, marketCap: XNO(50), buyVolume: XNO(60), sellVolume: XNO(40), holders: 5, change24h: 80, createdAt: 500,
       price: (10n ** 30n).toString(), decimals: 6, pool: "nano_poolcc",
       topHolders: [{ account: "nano_h2", balanceRaw: (9n * 10n ** 6n).toString(), pct: 90 }, { account: "nano_poolcc", balanceRaw: (100n * 10n ** 6n).toString(), pct: 0 }] }),
];

const lb = computeLeaderboards(tokens, 123, 10);

// tokens: CCC has the most volume (100 XNO), AAA the most holders, CCC the top gainer, BBB newest? no — cc newest (500)
assert.equal(lb.tokens.byVolume[0].tokenId, "cc", "byVolume ranks CCC first");
assert.equal(lb.tokens.byHolders[0].tokenId, "aa", "byHolders ranks AAA first");
assert.equal(lb.tokens.byGainers[0].tokenId, "cc", "byGainers ranks CCC (+80%) first");
assert.equal(lb.tokens.newest[0].tokenId, "cc", "newest ranks the latest createdAt first");

// creators: A launched 2 tokens with 48 holders; B launched 1 with 5. A should win + get Community + Serial? (count 2 < 3 so no Serial)
assert.equal(lb.creators[0].account, A, "creator A ranks first (more holders/tokens)");
assert.equal(lb.creators[0].tokenCount, 2);
assert.equal(lb.creators[0].holders, 48);
assert.ok(lb.creators[0].badges.includes("👥 Community"), "A earns Community badge (>=25 holders)");
assert.ok(!lb.creators[0].badges.includes("🚀 Serial"), "A has only 2 tokens, no Serial badge");
assert.ok(lb.creators.find((c) => c.account === A)!.badges.includes("💎 Blue Chip"), "A holds the top single-token mcap");

// determinism: recompute → identical
assert.deepEqual(computeLeaderboards(tokens, 123, 10), lb, "recompute is byte-identical (deterministic)");

// holders: pool account excluded; h2 (9 in CCC + 3 in AAA) tops the value board
assert.ok(!lb.holders.some((h) => h.account === "nano_poolcc"), "pool account is never ranked as a holder");
assert.equal(lb.holders[0].account, "nano_h2", "h2 has the most aggregate holdings value");
assert.ok(lb.holders[0].badges.includes("🐋 Whale"), "top holder gets the Whale badge");

// creatorReputation scopes to one account
assert.equal(creatorReputation(tokens, B)!.tokenCount, 1);
assert.equal(creatorReputation(tokens, "nano_nobody"), null);

console.log("✅ leaderboards derivation tests passed");
