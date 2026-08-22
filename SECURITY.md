# Security Policy

HodlGame's correctness rests on a deterministic replay; v2 zero-custody tokens hold no pooled value at all (settlement is wallet-to-wallet), while legacy pooled tokens' XNO sits in pool accounts. We take security seriously and welcome responsible
disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- GitHub's [private vulnerability reporting](https://github.com/dhyabi2/holdergame/security/advisories/new) (**Security → Report a vulnerability**), or
- a direct message to the maintainer ([@dhyabi2](https://github.com/dhyabi2)).

Please include:

- a description of the issue and its impact,
- a **runnable proof of concept** if you have one (this project's own audit method
  is "break the validation with a real PoC" — we love a concrete repro),
- the affected files / commit.

We aim to acknowledge within a few days and to fix confirmed issues promptly. We'll
credit you in the changelog unless you prefer to remain anonymous.

## Scope

In scope: the deterministic ledger (`nano/core`), the indexer and replay
(`nano/indexer`), the server APIs and settlement (`nano/server`), the client
signing and exchange flows (`nano/client`), custody (FROST signer, rotation), and
the HTTP layer of the web app.

Particularly interesting classes of bug:

- anything that lets an op mint supply, exceed the 5% creator cap, or move another
  account's balance/stake;
- **replay non-determinism** — two honest parties reaching different state roots;
- **RPC-forgery** — trusting an unsigned field (amount, subtype, block account)
  from a node instead of deriving it from the signed chain;
- pool custody / settlement double-pay or reserve drains;
- metadata-authority takeover or provisional-lock DoS.

## Threat model & audit

The design assumes a possibly-malicious RPC node and a possibly-malicious operator;
the ledger's trust comes from third parties re-deriving the same state root from
public blocks. We periodically run a **break-the-validation** audit that enumerates
every security gate and attacks each with a runnable PoC; confirmed breaks are
fixed one by one. See [`docs/SECURITY-AUDIT.md`](nano/docs/SECURITY-AUDIT.md).

## Supported versions

The project is pre-1.0; only `main` is supported. Fixes land on `main`.
