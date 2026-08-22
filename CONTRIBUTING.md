# Contributing to HodlGame

Thanks for helping. HodlGame is a deterministic Layer-2 — correctness *is* the
product, so the bar for changes to the ledger is high and the tests are the
contract. This guide gets you productive fast.

## Setup

```bash
git clone https://github.com/dhyabi2/hodlgame
cd holdergame/nano
npm install
npm test            # must be green before you start
```

For the web app:

```bash
cd nano/web
npm install
npm run dev
```

Requirements: Node 22+, a C compiler (for the optional local PoW helper via
`npm run build-workgen`).

## The one rule you must not break: no vendored drift

`nano/web` re-includes `core/`, `indexer/`, `server/`, `lib/`, and `client/` so
Vercel ships a self-contained app. **These are hand-synced copies.** If you edit
a shared file under `nano/`, you must copy it into `nano/web/` in the *same*
change, or vice-versa.

CI enforces this with a drift gate (`.github/workflows/ci.yml`): any divergence
between `nano/<dir>` and `nano/web/<dir>` fails the build, because drift means the
audited code is not the deployed code. Quick check before you push:

```bash
cd nano
for d in core client indexer lib server; do diff -rq "$d" "web/$d"; done
```

## Changing the ledger (`nano/core`)

The state machine must stay **pure and deterministic** — no wall-clock, no
randomness, no network, no per-account block height as an economic input (it is
attacker-inflatable). If your change alters replay output, it changes the state
root, which is a consensus change:

- Add or update tests in the relevant `*.test.ts` so the new behavior is pinned.
- Keep `applyOp` total: invalid ops throw `InvalidOp` and are *flagged*, never
  crash the replay.
- Re-run `npm test` — all 31 suites must pass.

## Tests

Every suite is offline and deterministic (`tsx <file>.test.ts`, run by
`npm test`). Add tests next to the code they cover. A PR that changes behavior
without a test that would have failed before is not ready.

## Pull requests

1. Branch off `main`.
2. Keep the change focused; match the surrounding style (no reformatting churn).
3. `npm test` green, `npx next build` green if you touched `nano/web`.
4. No vendored drift.
5. Fill in the PR template — what changed, why, and how you verified it.

## Security

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
