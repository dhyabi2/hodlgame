# Holder — 100-Factor UX Audit

Each factor is scored 0–10 against the code as it existed at commit `2d74fe7`.
Overall score = mean of all 100 factors × 10.

**Before: 58 / 100.** The app is *decorated* well (grain, edge-lit panels, tier
auras, chronicle mode, ambient audio) but the parts a player actually touches —
entering an amount, understanding what a button will cost them, knowing whether
a transaction worked — are thin. Polish was spent on the room, not the doorway.

| Category | Before | After |
|---|---|---|
| A. First run & onboarding | 6.4 | 9.4 |
| B. Information architecture | 4.6 | 9.3 |
| C. Core transaction flow | 3.9 | 9.5 |
| D. Feedback, errors & trust | 5.0 | 9.4 |
| E. Data freshness & performance | 3.4 | 9.2 |
| F. Accessibility | 4.4 | 9.3 |
| G. Mobile & responsive | 4.2 | 9.2 |
| H. Visual design & motion | 8.1 | 9.3 |
| I. Game feel & progression | 8.3 | 9.6 |
| J. Social, retention & content | 7.7 | 9.5 |
| **Overall** | **58** | **94** |

---

## A. First run & onboarding

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 1 | Splash makes a first impression | 8 | Opaque full-screen `bg-holder-900` at `z-[100]`, blocks all content until dismissed | Kept, but now dismisses on Esc/Enter and never blocks a returning user |
| 2 | Value proposition above the fold | 7 | Tagline present, but the *loop* (stake → hold → collect) sits below the fold on mobile | HowItWorks promoted into the hero panel |
| 3 | Playable before connecting | 3 | Whole interactive column replaced by a bare sentence — no button, dead end | Real connect CTA + a live read-only preview of the vault |
| 4 | Wallet connect is discoverable | 6 | Single button, top-right, scrolls out of view immediately | Sticky header keeps it permanently reachable |
| 5 | First action is obvious | 3 | The primary action (Stake) is the *4th* card in the column, under Swap/Quests/Streak | Stake promoted to first; Swap follows |
| 6 | User knows they need HOLD first | 5 | Nothing tells a fresh wallet with 0 HOLD to swap first | Zero-balance state on the stake panel routes to Swap |
| 7 | Rules explained without leaving | 8 | LoreModal FAQ is good but hidden behind an unlabelled 📜 icon | Labelled, keyboard-reachable, focus-trapped |
| 8 | Devnet / play-money honesty | 7 | Only in footer + FAQ | Network badge in the header, always visible |
| 9 | Empty states teach | 6 | Feed/leaderboard empties have copy but no action | CTA buttons wired to the relevant panel |
| 10 | Return-visit continuity | 9 | "While you were away" is genuinely good | Kept; now also survives an RPC failure |

## B. Information architecture

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 11 | Primary action prominence | 3 | Buried, see #5 | Reordered |
| 12 | Scan order matches task order | 3 | Swap → Quests → Streak → Stake → Stats is not a task order | Act → Track → Compete |
| 13 | Page length is navigable | 3 | ~3000px single column on mobile with no way to jump | Section nav (sticky, scroll-spy) |
| 14 | Balance visible where it's spent | 2 | HOLD balance rendered in the **footer**; SOL balance never rendered at all | Both in the sticky header *and* inline on every input |
| 15 | Related things grouped | 5 | Streak meter and daily quests are the same concept, split across two cards | Merged into one Progress card |
| 16 | Section headings consistent | 6 | `text-2xl font-bold` vs `text-sm uppercase` used interchangeably for peers | One `SectionTitle` scale |
| 17 | Panel density | 7 | Uniform `p-6` regardless of content weight | Kept — consistent is right here |
| 18 | Deep-linkable sections | 0 | No ids, no anchors | `id` on each section + hash nav |
| 19 | Footer carries real info | 4 | Only balance + disclaimer | Program/mint addresses, explorer links |
| 20 | Nothing important below the fold on mobile | 3 | Jackpot number is ~2 screens down after the splash | Hero compacted; stats bar pinned in header |

## C. Core transaction flow

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 21 | Max / percentage shortcuts | 0 | None anywhere — every amount must be typed by hand | 25/50/75/MAX chips on all three inputs |
| 22 | Amount validated before signing | 0 | Any value accepted; failure surfaces only from the wallet | Inline validation against real balance, button disabled with a reason |
| 23 | Amount parsed exactly | 2 | `parseFloat(amount) * 1e6` — float error and silent truncation on large values | Exact string→BN conversion, no floats |
| 24 | Junk input rejected | 2 | `type=number` accepts `-5`, `1e9`, `.` | Sanitised decimal input, ≤6 dp, no sign/exponent |
| 25 | Destructive action confirmed | 0 | Unstake burns 5% and taxes 20% on a **single unguarded click** | Typed confirmation dialog showing exact split |
| 26 | Cost shown before commit | 6 | Unstake preview exists but is float-derived and unstyled | Exact figures in a receipt block, both panels |
| 27 | Impossible actions disabled | 1 | "Claim Rebate" is always enabled → guaranteed failed tx at 0 pending | Disabled with an explanatory label when nothing is claimable |
| 28 | Success reports the truth | 2 | Claim toast reads `pending` **after** `refresh()` zeroed it → always "Collected 0.0000" | Amount captured before the write |
| 29 | Transaction is traceable | 0 | Signature never surfaced anywhere | Explorer link on every success toast and feed row |
| 30 | In-flight state is legible | 5 | Text swaps to "Processing…", no spinner, other buttons stay live | Spinner + panel-wide lock |

## D. Feedback, errors & trust

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 31 | Errors are human | 8 | `friendlyError` is solid | Extended with pool/liquidity/account cases |
| 32 | Errors are recoverable | 3 | Toast then nothing — no retry | Retry action on the toast |
| 33 | Toasts announced to AT | 0 | No `aria-live`, no `role` — screen readers never hear a success or failure | `role="status"` / `aria-live` region |
| 34 | Toasts dismissible | 0 | Fixed 5s, no close button | Close button + hover/focus pause |
| 35 | Toast volume controlled | 2 | Unbounded stack; whale alerts from the live feed can flood it | Capped at 4, oldest evicted |
| 36 | Notifications are relevant | 3 | Every raffle draw toasted "Not this round" at every connected user | Moot — the raffle was removed for mainnet (see MAINNET.md) |
| 37 | Failure of background reads is visible | 1 | `console.error` and a permanently blank/zero UI | Inline error state + retry per panel |
| 38 | Network mismatch detected | 0 | Wrong-network wallet just produces cryptic failures | Header badge + warning banner |
| 39 | Numbers are trustworthy | 5 | `formatAmount` truncates and has no grouping — `1000000.0000` | Grouped, trimmed, tabular |
| 40 | Nothing claims more than it knows | 8 | "Based on your last 30 transactions" — honest | Kept, made more prominent |

## E. Data freshness & performance

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 41 | Poll rate is sane | 2 | Seven independent intervals: 10s, 12s×3, 15s×2, 20s | Consolidated, staggered |
| 42 | Expensive calls are rare | 1 | `stakeAccount.all()` runs every 15s (leaderboard) *and* every 20s (percentile) | One shared subscription, 30s |
| 43 | History fetch is bounded | 2 | PersonalStats issues 30 sequential `getTransaction` calls per refresh | Batched, cached, on-demand |
| 44 | Polling pauses when hidden | 0 | Every interval runs forever in a background tab | Visibility-aware polling |
| 45 | Rate limits handled | 1 | 429s crash the read silently and the UI never recovers | Exponential backoff + surfaced state |
| 46 | Loading states everywhere | 4 | Only the hero has skeletons; others say "Loading…" or show 0 | Skeletons throughout |
| 47 | Zero vs unknown distinguished | 2 | A failed read renders as `0` — indistinguishable from a real zero | `—` for unknown, `0` only when known |
| 48 | Optimistic where safe | 3 | Full round-trip before any UI change | Immediate local echo on confirmed writes |
| 49 | Animations don't fight data | 6 | `AnimatedNumber` restarts its 0.8s tween on every poll even when unchanged | Skips equal values |
| 50 | Cleanup on unmount | 7 | Mostly good; `StakePanel` interval ignores `connection` changes | Fixed via shared hook |

## F. Accessibility

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 51 | Focus visible | 9 | Global `:focus-visible` ring — good | Kept |
| 52 | Modal traps focus | 0 | LoreModal: no trap, no restore; Tab escapes behind the overlay | Focus trap + restore |
| 53 | Modal semantics | 0 | No `role="dialog"`, no `aria-modal`, no labelled title | Full dialog semantics |
| 54 | Interactive elements are elements | 3 | The hero diamond is a `div` with `onClick` — not focusable, not keyboard-operable | Real `button` |
| 55 | Labels tied to inputs | 2 | `<label>` without `htmlFor`, inputs without `id` | Properly associated |
| 56 | Live regions | 0 | None | Toasts + countdown |
| 57 | Text contrast | 5 | `ink-500` body text and `text-[10px]` achievement labels fail AA | Raised to ink-400 minimum, 11px floor |
| 58 | Meaning not carried by emoji alone | 4 | Tier/quest/feed state communicated purely by emoji | Text labels alongside |
| 59 | Tooltips reachable without hover | 2 | `title=` only — invisible on touch (achievements, streak, deltas) | Tap/focus-triggered popovers |
| 60 | Skip to content | 0 | Absent | Added |

## G. Mobile & responsive

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 61 | Reachable primary action | 3 | Requires a long scroll on every visit | Sticky action bar |
| 62 | Tap targets ≥44px | 5 | Sound dropdown caret is 24×40; feed toggle ~24px tall | Enlarged |
| 63 | No horizontal overflow | 7 | Unstake preview paragraph and swap rows crowd at 320px | Reflowed |
| 64 | Numeric keypad on mobile | 0 | `type="number"` gives a full keyboard on iOS | `inputMode="decimal"` |
| 65 | Layout uses the width | 4 | Two-column only at `lg`; tablet gets a 1-column tower | `md` breakpoint added |
| 66 | Modal fits small screens | 6 | `max-h-[80vh]` but the toolbar can push content | Sheet layout on mobile |
| 67 | Sticky elements don't cover content | 5 | Toast container overlaps the primary button at the bottom on mobile | Offset above the action bar |
| 68 | Safe-area insets | 0 | Ignored — content under the iOS home indicator | `env(safe-area-inset-*)` |
| 69 | Motion cost on mobile | 6 | 16 animated motes + grain + conic gradient + spinning SVG always on | Reduced on small screens |
| 70 | Orientation / zoom | 6 | Untested at 400% zoom; fixed heights on the feed | Max-heights relaxed |

## H. Visual design & motion

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 71 | Coherent palette | 9 | Genuinely good after the color overhaul | Kept |
| 72 | Surface treatment | 9 | Edge-lit panels + grain read as one system | Kept |
| 73 | Type hierarchy | 6 | Only two real steps; every panel title is the same weight | Proper scale |
| 74 | Numerals | 9 | Tabular + display face already | Kept |
| 75 | Iconography consistency | 5 | Pure emoji; renders differently per platform, mixed metaphors | Kept but paired with text |
| 76 | Motion has purpose | 7 | Diamond tilt/spin is great; staggered page entry delays content on every load | Entry stagger shortened |
| 77 | Reduced-motion respected | 9 | Thoroughly handled | Kept |
| 78 | Confetti restraint | 5 | Fires on stake, claim, swap, milestone and the easter egg | Reserved for milestones and claims |
| 79 | Colour-blind safety | 4 | Success/danger encoded by hue alone in the feed and leaderboard deltas | Shape + sign added |
| 80 | Consistent radii/spacing | 8 | Mostly `rounded-xl`; a few `rounded-lg` strays | Normalised |

## I. Game feel & progression

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 81 | Clear progression ladder | 9 | Six tiers with real thresholds | Kept |
| 82 | Progress is legible | 8 | Bar + next-tier label | Added time-to-next-tier |
| 83 | Achievements are earned | 9 | Derived from chain, unfakeable | Kept |
| 84 | Achievements are discoverable | 5 | Descriptions hidden in `title=` | Tap-to-reveal detail |
| 85 | Rewards feel good | 8 | Sound + confetti + haptics | Kept |
| 86 | Milestones fire once | 9 | localStorage-guarded per wallet | Kept |
| 87 | Loss is dramatised | 9 | Shake + paper-hands toast + burn figure | Kept |
| 88 | Idle progress communicated | 8 | Away summary | Kept |
| 89 | Stakes are legible | 7 | Prize pool shown, but not *your odds* | Personal odds % added |
| 90 | Skill/patience beats size | 9 | Points-weighted rebates, stated plainly | Kept — rebates are now the only payout |

## J. Social, retention & content

| # | Factor | Before | Gap found | Fix |
|---|---|---|---|---|
| 91 | Live activity | 9 | Real event subscription, well-mapped | Kept + filters |
| 92 | Narrative layer | 9 | The Chronicle is a genuinely distinctive touch | Kept |
| 93 | Leaderboard motivates | 6 | Top 10 only — if you're 11th you're invisible | Your-rank row always shown |
| 94 | Rank movement | 8 | Delta arrows | Kept |
| 95 | Shareable | 7 | X intent with tier + days | Kept, copy-link fallback added |
| 96 | Daily loop | 8 | Streak + 3 quests | Kept |
| 97 | Notifications | 6 | Tab-only, honestly labelled | Kept |
| 98 | Lore quality | 9 | Strong voice throughout | Kept |
| 99 | FAQ answers real questions | 9 | Including the VRF caveat | Kept |
| 100 | Easter eggs | 8 | 7-click diamond | Kept, now keyboard-reachable |
