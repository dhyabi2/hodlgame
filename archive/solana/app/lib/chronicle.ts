/**
 * The Chronicle — turns the raw event feed into narrated lore.
 *
 * Variant selection is deterministic (hashed from the event id), so the same
 * event always reads the same way across reloads and across users. The
 * underlying numbers are untouched and still shown; this is flavour on top of
 * real data, never a substitute for it.
 */

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const STAKE_LINES = [
  "{who} sealed {amt} HOLD in the vault and walked away without looking back.",
  "The vault doors parted for {who}. {amt} HOLD went in.",
  "{who} committed {amt} HOLD to the long game.",
  "Another believer: {who} locked away {amt} HOLD.",
];

const UNSTAKE_LINES = [
  "{who} broke first. {amt} HOLD pulled out — the tax collector took its cut.",
  "Nerves gave way. {who} fled with {amt} HOLD, lighter than they arrived.",
  "{who} couldn't wait. {amt} HOLD withdrawn, a toll paid to those who stayed.",
  "The vault claimed its tribute as {who} exited with {amt} HOLD.",
];

const CLAIM_LINES = [
  "Patience paid: {who} collected {amt} HOLD from the vault.",
  "{who} came to collect. {amt} HOLD, earned by waiting.",
  "The vault paid out {amt} HOLD to {who}, funded by the impatient.",
];

const SWAP_LINES = [
  "{who} traded at the pool's edge.",
  "Fresh liquidity moved through {who}'s hands.",
  "{who} struck a deal with the pool.",
];

const POOLS: Record<string, string[]> = {
  stake: STAKE_LINES,
  unstake: UNSTAKE_LINES,
  claim: CLAIM_LINES,
  swap: SWAP_LINES,
};

export function chronicleLine(opts: {
  id: string;
  kind: string;
  user: string;
  amount: string;
}): string | null {
  const pool = POOLS[opts.kind];
  if (!pool) return null;
  const who = `${opts.user.slice(0, 4)}…${opts.user.slice(-4)}`;
  const line = pool[hashString(opts.id) % pool.length];
  return line.replace(/\{who\}/g, who).replace(/\{amt\}/g, opts.amount);
}
