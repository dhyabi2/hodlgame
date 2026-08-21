import { strict as assert } from "node:assert";
import * as nanocurrency from "nanocurrency";
import {
  immutableAnchorLink,
  setAuthorityAnchorLinks,
  isImmutableAnchor,
  isSetAuthorityAnchorA,
  assembleSetAuthority,
  tokenIdOfAnchor,
  deriveMetaAuthority,
  type MetaAnchor,
} from "./metaAnchor";
import { isFragA } from "./fraglink";

function addr(seedChar: string): string {
  const sk = nanocurrency.deriveSecretKey(seedChar.repeat(64), 0);
  return nanocurrency.deriveAddress(nanocurrency.derivePublicKey(sk), { useNanoPrefix: true });
}
const CREATOR = addr("1");
const NEW_OWNER = addr("2");
const ATTACKER = addr("3");
const TOKEN = "ab".repeat(16);

// 1. Immutable anchor: recognizable, tokenId round-trips, padding enforced.
{
  const link = immutableAnchorLink(TOKEN);
  assert.ok(isImmutableAnchor(link));
  assert.equal(tokenIdOfAnchor(link), TOKEN.toLowerCase());
  assert.ok(!isImmutableAnchor(link.slice(0, 62) + "01"), "nonzero padding rejected");
  assert.ok(!isFragA(link) && !isSetAuthorityAnchorA(link), "marker spaces disjoint");
}

// 2. setAuthority pair round-trips; padding + zero-pubkey enforced.
{
  const [a, b] = setAuthorityAnchorLinks(TOKEN, NEW_OWNER);
  assert.ok(isSetAuthorityAnchorA(a));
  const d = assembleSetAuthority(a, b);
  assert.equal(d.tokenId, TOKEN.toLowerCase());
  assert.equal(d.newAuthority, NEW_OWNER, "new authority survives pub round-trip");
  assert.throws(() => assembleSetAuthority(a, b.slice(0, 62) + "ff"), /padding/);
  assert.ok(!isFragA(a) && !isImmutableAnchor(a), "marker spaces disjoint");
}

// 3. Authority fold: creator seeds; only current authority's anchors count;
//    transfers chain; immutable freezes further changes.
{
  const creators = new Map([[TOKEN, CREATOR]]);
  const A = (over: Partial<MetaAnchor>): MetaAnchor => ({
    tokenId: TOKEN,
    kind: "immutable",
    sender: CREATOR,
    height: 1n,
    hash: "a".repeat(64),
    ...over,
  });

  // Attacker's anchors are ignored entirely.
  let st = deriveMetaAuthority([A({ sender: ATTACKER, kind: "immutable", hash: "b".repeat(64) })], creators);
  assert.deepEqual(st.get(TOKEN), { authority: CREATOR, immutable: false }, "non-authority anchor ignored");

  // Creator transfers, then NEW owner freezes; old creator's later anchor is dead.
  st = deriveMetaAuthority(
    [
      A({ kind: "setAuthority", newAuthority: NEW_OWNER, height: 1n, hash: "a".repeat(64) }),
      A({ kind: "immutable", sender: NEW_OWNER, height: 2n, hash: "b".repeat(64) }),
      A({ kind: "setAuthority", newAuthority: ATTACKER, sender: CREATOR, height: 3n, hash: "c".repeat(64) }),
      A({ kind: "setAuthority", newAuthority: ATTACKER, sender: NEW_OWNER, height: 4n, hash: "d".repeat(64) }),
    ],
    creators
  );
  assert.deepEqual(
    st.get(TOKEN),
    { authority: NEW_OWNER, immutable: true },
    "transfer chains, freeze is one-way, post-freeze transfers dead"
  );

  // Canonical ordering: same anchors in any input order → same result.
  const anchors = [
    A({ kind: "setAuthority", newAuthority: NEW_OWNER, height: 1n, hash: "a".repeat(64) }),
    A({ kind: "immutable", sender: NEW_OWNER, height: 2n, hash: "b".repeat(64) }),
  ];
  const fwd = deriveMetaAuthority(anchors, creators);
  const rev = deriveMetaAuthority([...anchors].reverse(), creators);
  assert.deepEqual(fwd.get(TOKEN), rev.get(TOKEN), "input-order independent");

  // Unknown token anchors are ignored.
  st = deriveMetaAuthority([A({ tokenId: "cd".repeat(16) })], creators);
  assert.deepEqual(st.get(TOKEN), { authority: CREATOR, immutable: false });
}

console.log("✅ metadata-authority anchor tests passed");
