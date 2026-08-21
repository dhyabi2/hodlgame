import { strict as assert } from "node:assert";
import { MemorySource, type NanoBlock } from "./blockSource";
import { MultiIndexer, metaMapResolver, commitMapResolver } from "./multiIndexer";
import { encodeOpLink } from "../core/oplink";
import { commitLink } from "../core/commit";
import { encodeFragLinks } from "../core/fraglink";
import * as nanocurrency from "nanocurrency";

/** Real nano_ address from a repeated-hex seed (fragment transfers need one). */
function nanoAddr(seedChar: string): string {
  const sk = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  return nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk), { useNanoPrefix: true });
}
import { tokenIdFromLaunchHash } from "../core/token";
import type { Op } from "../core/ops";

const CREATOR = "nano_creator";
const CREATOR_B = "nano_creator_b";
const ALICE = "nano_alice";

function mkBlock(
  account: string,
  link: string,
  height: bigint,
  hash: string,
  opts?: { previous?: string; amount?: string }
): NanoBlock {
  return { account, hash, previous: opts?.previous ?? "0".repeat(64), link, representative: account, height, amount: opts?.amount };
}

async function main() {
  // 1. Two launches → two isolated tokens, correct derived ids + real signer + 5%.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const launchB: Op = { kind: "launch", supply: 2_000_000_000_000n, name: "B", symbol: "B", decimals: 6, image: "" };
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const ta = tokenIdFromLaunchHash(hashA);
    const tb = tokenIdFromLaunchHash(hashB);

    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    source.push(mkBlock(CREATOR_B, encodeOpLink("", launchB), 2n, hashB));

    const meta = metaMapResolver(
      new Map([
        [ta, { name: "A", symbol: "A", decimals: 6, image: "" }],
        [tb, { name: "B", symbol: "B", decimals: 6, image: "" }],
      ])
    );

    const { applied, invalid } = await new MultiIndexer(source, meta).sync([CREATOR, CREATOR_B]);
    assert.equal(invalid, 0);
    assert.equal(applied, 2);

    const s = new MultiIndexer(source, meta);
    await s.sync([CREATOR, CREATOR_B]);
    assert.equal(s.getState().size, 2, "two tokens");
    const a = s.getState().get(ta)!;
    const b = s.getState().get(tb)!;
    assert.equal(a.creator, CREATOR, "real signer = creator");
    assert.equal(b.creator, CREATOR_B);
    assert.equal(a.name, "A", "per-token launch meta resolved");
    assert.equal(b.name, "B");
    assert.equal(a.creatorShare, (1_000_000_000_000n * 500n) / 10_000n);
    assert.equal(b.creatorShare, (2_000_000_000_000n * 500n) / 10_000n);
    assert.notEqual(a.supply, b.supply, "independent supplies");
  }

  // 2. buy routes to the right token: launched token A → "no liquidity" (proves
  //    the link's tokenId landed on A's state, not a fresh one → "not launched").
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const hashA = "c".repeat(64);
    const ta = tokenIdFromLaunchHash(hashA);
    const POOL_PUB = "9".repeat(64);
    const depHash = "d".repeat(64);

    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    // deposit: ALICE sends XNO to token A's pool (value-bound buy, part 1)
    source.push(mkBlock(ALICE, POOL_PUB, 2n, depHash, { amount: "10000000000000000000000000000" }));
    // buy op chained after the deposit (part 2)
    source.push(mkBlock(ALICE, encodeOpLink(ta, { kind: "buy", xno: 0n, minTokens: 0n }), 3n, "e".repeat(64), { previous: depHash, amount: "1" }));

    const poolKey = (id: string) => (id === ta ? POOL_PUB : null);
    const { applied, invalid, reasons } = await new MultiIndexer(source, undefined, undefined, poolKey).sync([CREATOR, ALICE]);
    assert.equal(applied, 1, "only launch applied");
    assert.equal(invalid, 1, "buy flagged");
    assert.ok(reasons.some((r) => /liquidity/.test(r)), "buy hit launched token A → 'no liquidity'");
  }

  // 3. Determinism: two syncs over the same source are identical.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const hashA = "e".repeat(64);
    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));

    const a = new MultiIndexer(source);
    const b = new MultiIndexer(source);
    await a.sync([CREATOR]);
    await b.sync([CREATOR]);
    assert.deepEqual(a.getState(), b.getState(), "indexer replay is byte-identical");
  }

  // 4. End-to-end: launch (compact) → seedLiq (commit-reveal) → buy (value-bound) → sell.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const seed: Op = { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n };
    const sell: Op = { kind: "sell", tokens: 10_000_000n, minXno: 0n };
    const hashA = "f".repeat(64);
    const ta = tokenIdFromLaunchHash(hashA);
    const POOL_PUB = "8".repeat(64);
    const depHash = "2".repeat(64);

    const seedDepHash = "5".repeat(64);

    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    // seed deposit (CREATOR sends 1e9 raw XNO to token A's pool, value-bound seedLiq part 1)
    source.push(mkBlock(CREATOR, POOL_PUB, 2n, seedDepHash, { amount: "1000000000" }));
    // seedLiq commit op chained after the seed deposit (part 2)
    source.push(mkBlock(CREATOR, commitLink(ta, seed), 3n, "1".repeat(64), { previous: seedDepHash }));
    // deposit (ALICE sends 100_000_000 raw XNO to token A's pool)
    source.push(mkBlock(ALICE, POOL_PUB, 3n, depHash, { amount: "100000000" }));
    // buy op chained after the deposit
    source.push(mkBlock(ALICE, encodeOpLink(ta, { kind: "buy", xno: 0n, minTokens: 0n }), 4n, "3".repeat(64), { previous: depHash, amount: "1" }));
    source.push(mkBlock(ALICE, encodeOpLink(ta, sell), 5n, "4".repeat(64), { previous: "3".repeat(64), amount: "1" }));

    const commits = commitMapResolver([{ tokenId: ta, op: seed }]);
    const poolKey = (id: string) => (id === ta ? POOL_PUB : null);
    const idx = new MultiIndexer(source, undefined, commits, poolKey);
    const { applied, invalid } = await idx.sync([CREATOR, ALICE]);
    assert.equal(invalid, 0, "full flow has no invalid ops");
    assert.equal(applied, 4, "launch + seedLiq + buy + sell all applied");

    const s = idx.getState().get(ta)!;
    assert.equal(s.launched, true);
    assert.ok(s.poolXno > 1_000_000_000n && s.poolXno <= 1_100_000_000n, "pool XNO = seedLiq 1e9 + buy 1e8 − sell out");
    assert.ok(s.poolTokens > 0n, "token has liquidity after seedLiq");
    assert.ok((s.balances.get(ALICE) ?? 0n) > 0n, "buyer holds tokens after buy/sell");
  }

  // 4b. Value-bound seedLiq: declared pool XNO that was never sent is skipped,
  //     and a real deposit's amount OVERRIDES an inflated declaration.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const inflated: Op = { kind: "seedLiq", xno: 999_000_000_000n, tokens: 950_000_000_000n };
    const hashA = "a1".padEnd(64, "0");
    const ta = tokenIdFromLaunchHash(hashA);
    const POOL_PUB = "7".repeat(64);
    const poolKey = (id: string) => (id === ta ? POOL_PUB : null);

    // Attack 1: inflated seedLiq with NO deposit chained → op is skipped entirely.
    {
      const source = new MemorySource();
      source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
      source.push(mkBlock(CREATOR, commitLink(ta, inflated), 2n, "b1".padEnd(64, "0")));
      const commits = commitMapResolver([{ tokenId: ta, op: inflated }]);
      const idx = new MultiIndexer(source, undefined, commits, poolKey);
      const { applied, invalid } = await idx.sync([CREATOR]);
      assert.equal(invalid, 0, "unbacked seedLiq is skipped, not applied-invalid");
      assert.equal(applied, 1, "only the launch applied");
      assert.equal(idx.getState().get(ta)!.poolXno, 0n, "no phantom pool XNO");
    }

    // Attack 2: inflated declaration but a real (smaller) deposit → the deposit
    // amount is authoritative.
    {
      const depHash = "c1".padEnd(64, "0");
      const source = new MemorySource();
      source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
      source.push(mkBlock(CREATOR, POOL_PUB, 2n, depHash, { amount: "1000000000" }));
      source.push(mkBlock(CREATOR, commitLink(ta, inflated), 3n, "d1".padEnd(64, "0"), { previous: depHash }));
      const commits = commitMapResolver([{ tokenId: ta, op: inflated }]);
      const idx = new MultiIndexer(source, undefined, commits, poolKey);
      const { applied, invalid } = await idx.sync([CREATOR]);
      assert.equal(invalid, 0);
      assert.equal(applied, 2, "launch + value-bound seedLiq applied");
      assert.equal(idx.getState().get(ta)!.poolXno, 1_000_000_000n, "poolXno = deposit, not declaration");
    }

    // Honest token-only add (xno = 0) still needs no deposit.
    {
      const tokenOnly: Op = { kind: "seedLiq", xno: 0n, tokens: 950_000_000_000n };
      const source = new MemorySource();
      source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
      source.push(mkBlock(CREATOR, commitLink(ta, tokenOnly), 2n, "e1".padEnd(64, "0")));
      const commits = commitMapResolver([{ tokenId: ta, op: tokenOnly }]);
      const idx = new MultiIndexer(source, undefined, commits, poolKey);
      const { applied, invalid } = await idx.sync([CREATOR]);
      assert.equal(invalid, 0);
      assert.equal(applied, 2, "launch + token-only seedLiq applied");
      assert.equal(idx.getState().get(ta)!.poolTokens, 950_000_000_000n);
    }
  }

  // 4c. Chain-derived pool resolution: with NO injected poolKey resolver, the
  //     e2e flow replays to the identical state (the first creator-signed seed
  //     deposit's link names the pool) — verification needs zero secrets.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const seed: Op = { kind: "seedLiq", xno: 1_000_000_000n, tokens: 950_000_000_000n };
    const hashA = "f2".padEnd(64, "0");
    const ta = tokenIdFromLaunchHash(hashA);
    const POOL_PUB = "8".repeat(64);
    const seedDepHash = "a2".padEnd(64, "0");
    const buyDepHash = "b2".padEnd(64, "0");

    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    source.push(mkBlock(CREATOR, POOL_PUB, 2n, seedDepHash, { amount: "1000000000" }));
    source.push(mkBlock(CREATOR, commitLink(ta, seed), 3n, "c2".padEnd(64, "0"), { previous: seedDepHash }));
    source.push(mkBlock(ALICE, POOL_PUB, 3n, buyDepHash, { amount: "100000000" }));
    source.push(mkBlock(ALICE, encodeOpLink(ta, { kind: "buy", xno: 0n, minTokens: 0n }), 4n, "d2".padEnd(64, "0"), { previous: buyDepHash, amount: "1" }));

    const commits = commitMapResolver([{ tokenId: ta, op: seed }]);
    // Secretless verifier: no poolKey resolver at all.
    const verifier = new MultiIndexer(source, undefined, commits);
    const { invalid } = await verifier.sync([CREATOR, ALICE]);
    assert.equal(invalid, 0);
    assert.equal(verifier.getChainPools().get(ta), POOL_PUB.toLowerCase(), "pool pubkey derived from chain");

    // Operator indexer with the custody resolver reaches the identical state.
    const operator = new MultiIndexer(source, undefined, commits, (id) => (id === ta ? POOL_PUB : null));
    await operator.sync([CREATOR, ALICE]);
    assert.deepEqual(verifier.getState(), operator.getState(), "secretless replay == operator replay");
    assert.equal(verifier.getState().get(ta)!.poolXno, 1_100_000_000n, "seed 1e9 + buy 1e8 credited");

    // Attack: a NON-creator "seed" chained from a deposit to an attacker
    // account must not establish the pool (creator-signed only).
    const evilSeed: Op = { kind: "seedLiq", xno: 1n, tokens: 1n };
    const EVIL_POOL = "6".repeat(64);
    const evilDep = "e2".padEnd(64, "0");
    const source2 = new MemorySource();
    source2.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    source2.push(mkBlock(ALICE, EVIL_POOL, 1n, evilDep, { amount: "5" }));
    source2.push(mkBlock(ALICE, commitLink(ta, evilSeed), 2n, "f5".padEnd(64, "0"), { previous: evilDep }));
    const v2 = new MultiIndexer(source2, undefined, commitMapResolver([{ tokenId: ta, op: evilSeed }]));
    await v2.sync([CREATOR, ALICE]);
    assert.equal(v2.getChainPools().get(ta), undefined, "non-creator cannot establish a pool");
  }

  // 4d. Fragment links + compact seedLiq: the full flow with ZERO off-chain
  //     payloads — compact seed (deposit-bound), fragment sell with slippage,
  //     fragment transfer. Dangling frag A ignored; frag B never mis-decoded.
  {
    const launchA: Op = { kind: "launch", supply: 1_000_000_000_000n, name: "A", symbol: "A", decimals: 6, image: "" };
    const hashA = "a3".padEnd(64, "0");
    const ta = tokenIdFromLaunchHash(hashA);
    const POOL_PUB = "8".repeat(64);
    const BOB = nanoAddr("7");

    const source = new MemorySource();
    source.push(mkBlock(CREATOR, encodeOpLink("", launchA), 1n, hashA));
    // compact seedLiq chained from the pool deposit — no commit registry at all
    source.push(mkBlock(CREATOR, POOL_PUB, 2n, "b3".padEnd(64, "0"), { amount: "1000000000" }));
    source.push(
      mkBlock(CREATOR, encodeOpLink(ta, { kind: "seedLiq", xno: 0n, tokens: 950_000_000_000n }), 3n, "c3".padEnd(64, "0"), {
        previous: "b3".padEnd(64, "0"),
      })
    );
    // ALICE buys (value-bound as before)
    source.push(mkBlock(ALICE, POOL_PUB, 3n, "d3".padEnd(64, "0"), { amount: "100000000" }));
    source.push(
      mkBlock(ALICE, encodeOpLink(ta, { kind: "buy", xno: 0n, minTokens: 0n }), 4n, "e3".padEnd(64, "0"), {
        previous: "d3".padEnd(64, "0"),
        amount: "1",
      })
    );
    // ALICE sells with slippage via FRAGMENT links (payload fully on-chain)
    const sellOp: Op = { kind: "sell", tokens: 10_000_000n, minXno: 1n };
    const [sa, sb] = encodeFragLinks(ta, sellOp);
    source.push(mkBlock(ALICE, sa, 5n, "f3".padEnd(64, "0"), { previous: "e3".padEnd(64, "0"), amount: "1" }));
    source.push(mkBlock(ALICE, sb, 6n, "a4".padEnd(64, "0"), { previous: "f3".padEnd(64, "0"), amount: "1" }));
    // ALICE transfers tokens to BOB via fragments
    const xferOp: Op = { kind: "transfer", to: BOB, amount: 1_000_000n };
    const [xa, xb] = encodeFragLinks(ta, xferOp);
    source.push(mkBlock(ALICE, xa, 7n, "b4".padEnd(64, "0"), { previous: "a4".padEnd(64, "0"), amount: "1" }));
    source.push(mkBlock(ALICE, xb, 8n, "c4".padEnd(64, "0"), { previous: "b4".padEnd(64, "0"), amount: "1" }));
    // A DANGLING frag A (no B) must be ignored, not corrupt anything.
    const [da] = encodeFragLinks(ta, { kind: "sell", tokens: 5n, minXno: 5n });
    source.push(mkBlock(ALICE, da, 9n, "d4".padEnd(64, "0"), { previous: "c4".padEnd(64, "0"), amount: "1" }));

    const idx = new MultiIndexer(source); // NO commit resolver, NO poolKey — chain only
    const { applied, invalid } = await idx.sync([CREATOR, ALICE]);
    assert.equal(invalid, 0, "no invalid ops");
    assert.equal(applied, 5, "launch + seed + buy + frag-sell + frag-transfer applied; dangling A ignored");

    const s = idx.getState().get(ta)!;
    assert.ok(s.poolTokens > 0n, "pool seeded");
    assert.ok(s.poolXno > 1_000_000_000n, "seed deposit credited via compact link");
    assert.ok((s.balances.get(BOB) ?? 0n) > 0n, "fragment transfer delivered tokens to BOB");
  }

  // 5. amount guard: a value transfer (amount > 1 raw) is never decoded as an op,
  //    even if its destination pubkey's first byte looks like an opcode.
  {
    const source = new MemorySource();
    source.push(mkBlock(ALICE, "03" + "a".repeat(62), 1n, "f".repeat(64), { amount: "10000000000000000000000000000" }));
    const events = await new MultiIndexer(source).collectEvents([ALICE]);
    assert.equal(events.length, 0, "value transfer not decoded as an op");
  }

  console.log("✅ multi-token indexer tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});