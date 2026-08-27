# Exit Pays You — the core viral loop

Chosen by the invention methodology on 2026-08-27: research the best-in-class
launchpad, table the reasons it wins, brainstorm 7 better ideas per reason with
the Methodology-Tree engine (56 total), rank, adversarially judge the top 5.

## Why pump.fun wins (research)

| # | Reason |
|---|--------|
| 1 | Token creation in seconds, no liquidity needed |
| 2 | Bonding curve → public "graduation" moment |
| 3 | Creator fee share — creators are paid to promote forever |
| 4 | Native livestream: attention → price in minutes |
| 5 | Real-time global firehose (coins / trades ticker) |
| 6 | Closed in-app loop (launch → trade → share) |
| 7 | Mobile / fiat onboarding |
| 8 | Token-page chat as community |

## Ranking (top 5 of 56, deep-mode adversarial judge)

| Rank | Idea | Verdict |
|------|------|---------|
| **1** | **Exit Pays You** — every unstake is a visible, verifiable payout to the people who stayed | Core hook. Exploits the exit-tax rule no launchpad has and cannot copy without matching the tokenomics. Loop: exit → receipt shared → "I want to be on the receiving side" → stake. |
| 2 | Real-time King of the Hill | Ego loop, no financial feedback |
| 3 | Proof-of-Hold badges | Status only, low viral multiplier |
| 4 | Stake-to-Chat | Utility, doesn't move price |
| 5 | Copy-trading | Technical risk, bot-replicable |
| ✗ | Referral cuts in block links (appeared in 7/8 categories) | Needs a ledger-rule change → forbidden while live |

Judge's flagged weakness: wash exits to spam notifications. Design-out: an
unstake pays *others* 20% of real tokens, so a fake exit costs real money; rows
never shame (no "dumped"/"quitter" copy — receipt tone only).

## Blocks (each brainstormed, then built)

1. **Derivation** — `server/exits.ts`: during the analytics fold, snapshot stakes
   before each unstake and attribute the rebate with the ledger's own integer
   math (`share = stake × Δrps / PRECISION`, floored per account). Rebate/burn are
   read off the state deltas, so an era change can never desync it. Test proves
   every share equals `claimableReward` to the raw unit. No consensus change.
2. **Token page panel** (`ExitPaysYou` in `web/app/page.tsx`, inside the Stake
   box): headline = *exit tax paid to you* (lifetime) or *paid to stayers*;
   receipt-style tape (who left · tax → N stayers · **you +X (+y% on your
   stake)**); each row links to the unstake block on Nano; honest empty state;
   "Stake to get paid by the next exit" CTA for holders who aren't staked.
3. **Receipt share card** — monochrome 1080² card via `lib/sharecard.ts`:
   `+X $SYM · "0xab… left. I stayed. They paid me." · their tax / split between
   N / my cut +y%` · footer names the block hash so the claim is re-verifiable.
4. **Home firehose** (`ExitTicker`): latest exits across every coin, newest
   first, each chip opens the coin; chips that paid the viewer render inverted.

## API surface

`TokenView.exits: ExitView[]` (newest first; 30 on detail, 3 on the feed) and
`TokenView.exitStats { count, paidRaw, burnedRaw, myEarnedRaw, lastTime }`.
Everything is derived from the same replay as balances — any replayer gets the
identical list.
