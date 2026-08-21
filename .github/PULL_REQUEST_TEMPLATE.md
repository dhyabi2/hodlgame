<!-- Thanks for contributing to HoldFun. Keep PRs focused. -->

## What & why

<!-- What does this change do, and why? Link any issue with "Closes #123". -->

## How I verified it

<!-- Commands run, scenarios tested. Paste relevant output. -->

- [ ] `cd nano && npm test` is green (31 suites)
- [ ] `cd nano/web && npx next build` is green (if the web app was touched)

## Checklist

- [ ] Change is focused; no unrelated reformatting.
- [ ] **No vendored drift** — shared files under `nano/` were copied into
      `nano/web/` in this PR (or the change is web-only / nano-only).
      Verified with `for d in core client indexer lib server; do diff -rq nano/$d nano/web/$d; done`.
- [ ] Behavior changes come with a test that would have failed before.
- [ ] Ledger changes (`nano/core`) stay pure/deterministic — no wall-clock,
      randomness, network, or per-account block height as an economic input.
- [ ] No secrets, keys, or `.env` values committed.
- [ ] For security-sensitive issues I used private disclosure (see SECURITY.md),
      not this PR.
