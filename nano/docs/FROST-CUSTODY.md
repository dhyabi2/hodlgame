# FROST 2-of-3 pool custody (W1) — deployment runbook

Goal: retire the single `POOL_SEED` (one key that can drain every pool) for a
**2-of-3 blake2b-FROST** group, reusing the production stack from
`~/verifyXNOPrivacyProtocol` (BlackBird/VELA), which already runs live 2-of-3
custody on Nano mainnet. After this, **no single machine or party can move
pool funds**, and each cosigner independently re-derives the payout from its
own settlement replay before signing.

## Security level (honest)

This gives HoldFun **exactly VELA's security level** — a large step up from
single-key. It defends:
- **single-box compromise** (an attacker on one VPS gets one share < quorum);
- **app-tier compromise** (a broken HoldFun coordinator can't move funds — a
  cosigner rejects any payout not owed per its own replay);
- **one-box loss** (2-of-3 liveness).

The one residual it shares with VELA: **a single admin with root/SSH to all
three boxes** can read 2 shares. That is unavoidable until the three boxes have
independent operators; it matches the model VELA already runs real funds on.
Two-box loss freezes funds by design (keep the recovery shares safe).

## The three boxes (Hostinger fleet)

| Role | Host | IP |
|------|------|----|
| coordinator + cosigner-A | srv1906844.hstgr.cloud | 186.241.20.130 |
| cosigner-B | srv1912248.hstgr.cloud | 76.13.220.231 |
| cosigner-C | srv1912738.hstgr.cloud | 168.231.114.66 |

## Prerequisite — DE-ROOT VELA's cosigners FIRST (mandatory)

VELA's cosigners run `User=root` (`config/vela-cosigner.service`). Until that
changes, a HoldFun `0600` share is readable by VELA's root process and the
isolation is fiction. On each box:

```
adduser --system --group vela-cosigner
chown -R vela-cosigner:vela-cosigner /opt/vela/data/frost
sed -i 's/^User=root/User=vela-cosigner/' /etc/systemd/system/vela-cosigner.service
systemctl daemon-reload && systemctl restart vela-cosigner
# verify VELA still signs (test withdrawal) before continuing
```

> ⚠️ This touches VELA's LIVE custody. Snapshot each box first
> (`hostinger vps snapshots create <id>`), do one box at a time, and confirm
> VELA still produces a 2-of-3 signature before moving on.

## Stand up HoldFun's independent group

Per box, as a **separate user** so a VELA compromise can't reach HoldFun's
share (and vice-versa):

```
adduser --system --group holdfun-cosigner
install -d -m 0700 -o holdfun-cosigner -g holdfun-cosigner /opt/holdfun/data/frost
```

HoldFun config (fresh secrets, NOT VELA's):
- `/opt/holdfun/.cosigner_api_key`  ← `openssl rand -hex 32`
- `/opt/holdfun/.verify_key`        ← `openssl rand -hex 32` (loopback to the verifier)
- `FROST_DATA_DIR=/opt/holdfun/data/frost`, `COSIGNER_PORT=8083`

`ufw allow from 186.241.20.130 to any port 8083` on B and C; verifier listens
on loopback only.

## The cosigner + verifier on each box

Two processes per cosigner box:
1. **FROST cosigner** — `deploy/holdfun_cosigner.py` (this repo): VELA's FROST
   cosigner with HoldFun's policy — it POSTs the payout `context` to the local
   HoldFun verifier and signs only on approval.
2. **HoldFun verifier** — `npm run operator` (server/server.ts) with
   `POOL_SEED` (to derive pool ADDRESSES, never to sign), `VERIFY_KEY`,
   `NANO_RPC_KEY`, `WATCHED_ACCOUNTS`/anchor. Exposes `POST /frost/verify-payout`
   on loopback; the cosigner calls it. Fails closed.

## The coordinator

On the coordinator box, run VELA's `frost_signer.py` pointed at HoldFun's key
group + a thin HTTP gateway exposing `POST /sign` (accepts the block fields +
context from HoldFun's sweep, runs the FROST round, returns the signed block).
HoldFun's operator reaches it via `FROST_COORDINATOR_URL` + `FROST_COORDINATOR_KEY`.

## Key generation (DKG)

```
# in ~/verifyXNOPrivacyProtocol, with config/holdfun_hosts.json (same 3 IPs,
# dir=/opt/holdfun/data/frost, owner=holdfun-cosigner:holdfun-cosigner)
python3 scripts/frost_ceremony.py --hosts config/holdfun_hosts.json
```

Dealerless — the full key is never assembled. The ceremony test-signs every
2-of-3 pair before activating. It refuses to overwrite existing shares, so
VELA's group is untouched. **Encrypt the shares at rest** (age/LUKS) — VELA
stores them plaintext `0600`; do better.

## Migrate off POOL_SEED

**New tokens: immediate.** A token's pool address is the link of its first
creator seed deposit (`derivePoolKeysFromChain`). Seed new tokens straight to
the FROST group's address and they are FROST-custodied from birth — `POOL_SEED`
is never involved.

**Existing tokens: pool rotation (built — VELA `legacy_pubkeys` analogue).**
Run, per token, once the FROST group's `group_pubkey` exists:

```
POOL_SEED=<64hex> npx tsx scripts/frost-migrate.ts <tokenId> <newPoolPubHex> --dry-run
POOL_SEED=<64hex> npx tsx scripts/frost-migrate.ts <tokenId> <newPoolPubHex>
```

Signed by the CURRENT (POOL_SEED) pool key, it (1) **announces** the successor
on-chain — a 1-raw block from the old pool with `representative = ROTATE_MARKER`
and `link = newPoolPub` (`core/rotate.ts`); the indexer follows the chain so
the FROST address becomes CURRENT while the old address stays LEGACY (historical
deposits still value-bind against it) — and (2) **sweeps** the balance to the
FROST address. Idempotent (skips an already-announced rotation / drained pool).
The FROST group then RECEIVEs the swept funds via its own signing and hellos to
self-register. Destroy `POOL_SEED` only after confirming the FROST balances
(keep it sealed as a recovery artifact, like VELA retired its single-key seed).

## Rollout order

1. Snapshot all 3 boxes.
2. De-root VELA cosigners (one at a time, verify VELA signs).
3. Create holdfun-cosigner user + dirs + config on all 3.
4. Deploy HoldFun verifier + cosigner; deploy coordinator + gateway.
5. Run DKG; encrypt shares.
6. Set `FROST_COORDINATOR_URL` on the HoldFun operator; sweeps now threshold-sign.
7. Migrate each pool; destroy POOL_SEED.

Until step 6, HoldFun keeps signing single-key (unchanged) — the switch is a
single env var, reversible by unsetting it.
