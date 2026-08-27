// "Exit Pays You" — pure derivation of exit-payout events from the replay.
//
// HodlGame's one rule no other launchpad has: unstaking pays a 20% tax that is
// redistributed pro-rata to everyone STILL staked. The ledger does this through
// the `rewardPerShare` accumulator (core/state.ts), which is exact but silent:
// nobody can see "who left, who got paid, how much". This module makes every
// exit a visible, verifiable event, computed with the SAME integer math the
// ledger uses (share = stake × Δrps / PRECISION), so the numbers shown are the
// numbers `settle()` will actually credit — never an estimate.
//
// Pure: no network, no custody, no consensus change. Any replayer derives the
// identical event list from the same blocks.

import { PRECISION, type State } from "../core/state";

export interface ExitRecipient {
  account: string;
  gotRaw: string; // token-raw credited by this exit (ledger-exact rounding)
  stakeRaw: string; // their stake at the moment of the exit
  yieldBps: number; // gotRaw / stakeRaw in basis points (1 bp = 0.01%)
}

export interface ExitEvent {
  tokenId: string;
  hash: string; // unstake block hash (verifiable on-chain)
  time: number; // epoch seconds (or height fallback)
  account: string; // who left
  amountRaw: string; // tokens unstaked
  taxRaw: string; // 20% tax
  rebateRaw: string; // tax paid to remaining stakers
  burnRaw: string; // tax burned (legacy era share / nobody left to pay)
  recipients: ExitRecipient[]; // everyone paid (>0), largest first
  remainingStakedRaw: string; // total stake that shared the rebate
}

export interface ExitLedger {
  events: ExitEvent[]; // chronological
  /** account → cumulative token-raw earned from OTHER people's exits. */
  earned: Map<string, bigint>;
  paidRaw: bigint; // total rebate ever paid to stakers
  burnedRaw: bigint;
}

export function emptyExitLedger(): ExitLedger {
  return { events: [], earned: new Map(), paidRaw: 0n, burnedRaw: 0n };
}

/** Snapshot the parts of state an exit needs BEFORE the unstake is applied. */
export interface PreExit {
  staked: Map<string, bigint>;
  totalStaked: bigint;
  rebateVault: bigint;
  supply: bigint;
}

export function preExit(s: State): PreExit {
  return { staked: new Map(s.staked), totalStaked: s.totalStaked, rebateVault: s.rebateVault, supply: s.supply };
}

/**
 * Fold one applied unstake into the ledger. `pre` is the snapshot taken before
 * applyOp; `post` the state after. Rebate/burn are read off the state deltas
 * (not recomputed), so an era change in core/state.ts can never desync this.
 */
export function recordExit(
  led: ExitLedger,
  pre: PreExit,
  post: State,
  ev: { tokenId: string; hash: string; sender: string; amount: bigint; time: number }
): ExitEvent {
  const rebate = post.rebateVault - pre.rebateVault;
  const burn = pre.supply - post.supply;
  const remaining = pre.totalStaked - ev.amount;
  const recipients: ExitRecipient[] = [];
  if (rebate > 0n && remaining > 0n) {
    // Identical to syncRewards + settle: Δrps = rebate·P / remaining;
    // share = stake·Δrps / P — floor at each step, exactly like the ledger.
    const drps = (rebate * PRECISION) / remaining;
    for (const [a, stakeBefore] of pre.staked) {
      const stake = a === ev.sender ? stakeBefore - ev.amount : stakeBefore;
      if (stake <= 0n) continue;
      const got = (stake * drps) / PRECISION;
      if (got <= 0n) continue;
      recipients.push({
        account: a,
        gotRaw: got.toString(),
        stakeRaw: stake.toString(),
        yieldBps: Number((got * 10_000n) / stake),
      });
      led.earned.set(a, (led.earned.get(a) ?? 0n) + got);
    }
    recipients.sort((x, y) => (BigInt(y.gotRaw) > BigInt(x.gotRaw) ? 1 : BigInt(y.gotRaw) < BigInt(x.gotRaw) ? -1 : x.account < y.account ? -1 : 1));
  }
  led.paidRaw += rebate;
  led.burnedRaw += burn;
  const e: ExitEvent = {
    tokenId: ev.tokenId,
    hash: ev.hash,
    time: ev.time,
    account: ev.sender,
    amountRaw: ev.amount.toString(),
    taxRaw: (rebate + burn).toString(),
    rebateRaw: rebate.toString(),
    burnRaw: burn.toString(),
    recipients,
    remainingStakedRaw: remaining.toString(),
  };
  led.events.push(e);
  return e;
}

/** Viewer-facing slice of an exit: everyone's totals + "what YOU got". */
export interface ExitView extends Omit<ExitEvent, "recipients"> {
  paidCount: number;
  top: ExitRecipient[]; // top 3 recipients
  mine: ExitRecipient | null; // the viewer's own share, if any
}

export function exitView(e: ExitEvent, account = ""): ExitView {
  const { recipients, ...rest } = e;
  return {
    ...rest,
    paidCount: recipients.length,
    top: recipients.slice(0, 3),
    mine: account ? recipients.find((r) => r.account === account) ?? null : null,
  };
}
