// Shared client-side trading + formatting helpers used by both the simple
// one-page app and the Pro terminal. All chain writes go through /api/rpc; the
// quote math mirrors core/state.ts (constant product, 1% buy swap-fee, no sell
// fee) so previews never disagree with on-chain execution.

import * as nanocurrency from "nanocurrency";
import { encodeOpLink } from "../../core/oplink";
import { encodeFragLinks } from "../../core/fraglink";
import { ANCHOR_PUB } from "../../core/anchor";
import type { Op } from "../../core/ops";

export interface Keys {
  secretKey: string;
  publicKey: string;
  address: string;
}

const WORK_DIFF = "fffffff800000000";
const RECEIVE_DIFF = "fffffe0000000000";

export async function rpc(action: string, params: Record<string, unknown>) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
  return j;
}

export function buildBlock(
  secretKey: string,
  opts: { work: string; previous: string | null; representative: string; balance: string; link: string }
) {
  const b = nanocurrency.createBlock(secretKey, {
    work: opts.work,
    previous: opts.previous,
    representative: opts.representative,
    balance: opts.balance,
    link: opts.link,
  });
  const blk: any = { ...b.block };
  blk.account = blk.account.replace(/^xrb_/, "nano_");
  delete blk.link_as_account;
  return blk;
}

// ── quotes (mirror of the on-chain AMM) ─────────────────────────────────────
export const quoteBuy = (poolXno: string, poolTokens: string, xno: bigint): bigint => {
  const px = BigInt(poolXno);
  const pt = BigInt(poolTokens);
  if (px <= 0n || pt <= 0n) return 0n;
  const afterFee = (xno * 9900n) / 10000n;
  return (afterFee * pt) / (px + afterFee);
};

export const quoteSell = (poolXno: string, poolTokens: string, tokens: bigint): bigint => {
  const px = BigInt(poolXno);
  const pt = BigInt(poolTokens);
  if (px <= 0n || pt <= 0n) return 0n;
  return (tokens * px) / (pt + tokens);
};

// ── formatting ──────────────────────────────────────────────────────────────
export const fmtTok = (raw: string | undefined, dec: number) => {
  if (!raw) return "0";
  const n = BigInt(raw);
  const d = 10n ** BigInt(dec);
  const whole = n / d;
  const frac = (n % d).toString().padStart(dec, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole.toString();
};

// Human-readable numbers, never scientific notation ("1.27e-14" reads as
// garbage to most people). Tiny values use the DEX-style zero-count form:
// 0.0₁₃127 means "0., thirteen zeros, then 127". Large values compact to K/M/B.
const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const subNum = (n: number) => String(n).split("").map((c) => SUBSCRIPT_DIGITS[Number(c)]).join("");

export function fmtNum(v: number, sig = 3): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const neg = v < 0 ? "-" : "";
  const n = Math.abs(v);
  const trim = (s: string) => s.replace(/\.?0+$/, "");
  if (n >= 1e9) return neg + trim((n / 1e9).toFixed(2)) + "B";
  if (n >= 1e6) return neg + trim((n / 1e6).toFixed(2)) + "M";
  if (n >= 1e3) return neg + trim((n / 1e3).toFixed(2)) + "K";
  if (n >= 0.0001) {
    const dec = Math.min(8, Math.max(2, sig - 1 - Math.floor(Math.log10(n))));
    return neg + n.toFixed(dec).replace(/0+$/, "").replace(/\.$/, "");
  }
  let zeros = -Math.floor(Math.log10(n)) - 1;
  let digits = Math.round(n * 10 ** (zeros + sig));
  if (String(digits).length > sig) { digits = Math.round(digits / 10); zeros -= 1; } // rounding carried a digit
  const ds = String(digits).replace(/0+$/, "") || "0";
  return `${neg}0.0${subNum(zeros)}${ds}`;
}

export const fmtXno = (raw: string | undefined) => {
  if (!raw) return "0";
  return fmtNum(Number(BigInt(raw)) / 1e30);
};

/** Exact plain-decimal XNO string (parseable by toRaw) — for pre-filling
 * inputs, e.g. the Max button. Display should use fmtXno instead. */
export function fmtXnoPlain(raw: string | undefined): string {
  if (!raw) return "0";
  const n = BigInt(raw);
  const d = 10n ** 30n;
  const whole = n / d;
  const frac = (n % d).toString().padStart(30, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Exact decimal-string → raw bigint. No Number involved, so no precision loss
 * (critical for XNO's 30 decimals — `Number("0.5")*1e30` is already inexact).
 * Returns 0n for empty / non-numeric / negative / scientific input. */
export function toRaw(s: string, decimals: number): bigint {
  const t = (s ?? "").trim();
  if (t === "" || t === "." || !/^\d*\.?\d*$/.test(t)) return 0n; // digits + one dot only (no "-", "e", etc.)
  const [int = "", frac = ""] = t.split(".");
  const d = Math.max(0, Math.floor(decimals));
  const fracPadded = (frac + "0".repeat(d)).slice(0, d);
  try {
    return BigInt(int || "0") * 10n ** BigInt(d) + BigInt(fracPadded || "0");
  } catch {
    return 0n;
  }
}

/** Clamp a slippage-% string to a sane [0, 100]; NaN → 0. */
export function clampSlippage(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** True for a well-formed nano_/xrb_ address (client-side pre-check). */
export function isNanoAddr(a: string): boolean {
  return /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test((a ?? "").trim());
}

export const short = (a: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const pctStr = (n: number | null | undefined) =>
  n == null ? "·" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function timeAgo(ts: number) {
  const t = ts > 1e12 ? ts : ts * 1000;
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── chain writes ────────────────────────────────────────────────────────────

/** 1-raw hello to the protocol anchor so any indexer discovers this account
 * from chain data alone. Best-effort; never blocks an op. */
async function ensureHello(keys: Keys): Promise<void> {
  const flag = `holdfun-hello-${keys.address}`;
  try {
    if (localStorage.getItem(flag)) return;
  } catch {}
  try {
    const info = await rpc("account_info", { account: keys.address, representative: "true" });
    if (!info.frontier) return;
    const work = (await rpc("work_generate", { hash: info.frontier, difficulty: WORK_DIFF })).work;
    const blk = buildBlock(keys.secretKey, {
      work,
      previous: info.frontier,
      representative: info.representative,
      balance: (BigInt(info.balance) - 1n).toString(),
      link: ANCHOR_PUB,
    });
    await rpc("process", { json_block: "true", block: blk });
    try {
      localStorage.setItem(flag, "1");
    } catch {}
  } catch {}
}

/** Append one op link to the account chain, burning `delta` raw. Returns hash. */
export async function submitLink(keys: Keys, link: string, delta: bigint): Promise<string> {
  await ensureHello(keys);
  const info = await rpc("account_info", { account: keys.address, representative: "true" });
  if (!info.frontier) throw new Error("account not opened — fund it first");
  const work = (await rpc("work_generate", { hash: info.frontier, difficulty: WORK_DIFF })).work;
  const blk = buildBlock(keys.secretKey, {
    work,
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - delta).toString(),
    link,
  });
  const r = await rpc("process", { json_block: "true", block: blk });
  return r.hash as string;
}

export async function sendOp(keys: Keys, tokenId: string, op: Op): Promise<string> {
  return submitLink(keys, encodeOpLink(tokenId, op), 1n);
}

/** Buy: a real-value XNO deposit to the token pool, then a buy op chained
 * directly after it (previous = deposit hash). minTokens enforces slippage. */
export async function execBuy(
  keys: Keys,
  token: { tokenId: string; pool: string | null; poolXno: string; poolTokens: string },
  xnoAmount: string,
  slipPctRaw: number
): Promise<string> {
  if (!token.pool) throw new Error("token has no pool yet");
  const raw = toRaw(xnoAmount, 30); // XNO = 10^30 raw
  const slipPct = Math.min(100, Math.max(0, Number.isFinite(slipPctRaw) ? slipPctRaw : 0));
  if (raw <= 0n) throw new Error("enter XNO amount");
  const info = await rpc("account_info", { account: keys.address, representative: "true" });
  if (!info.frontier) throw new Error("account not opened — fund it first");

  const w1 = (await rpc("work_generate", { hash: info.frontier, difficulty: WORK_DIFF })).work;
  const blk1 = buildBlock(keys.secretKey, {
    work: w1,
    previous: info.frontier,
    representative: info.representative,
    balance: (BigInt(info.balance) - raw).toString(),
    link: token.pool,
  });
  const r1 = await rpc("process", { json_block: "true", block: blk1 });

  let minTokens = 0n;
  if (slipPct > 0) {
    const expected = quoteBuy(token.poolXno, token.poolTokens, raw);
    minTokens = (expected * BigInt(Math.round((100 - slipPct) * 100))) / 10000n;
  }
  const opLink = encodeOpLink(token.tokenId, { kind: "buy", xno: 0n, minTokens });
  const w2 = (await rpc("work_generate", { hash: r1.hash, difficulty: WORK_DIFF })).work;
  const blk2 = buildBlock(keys.secretKey, {
    work: w2,
    previous: r1.hash,
    representative: info.representative,
    balance: (BigInt(info.balance) - raw - 1n).toString(),
    link: opLink,
  });
  const r2 = await rpc("process", { json_block: "true", block: blk2 });
  return r2.hash as string;
}

/** Sell tokens for XNO. With slippage protection the full op is carried
 * on-chain across two chained fragment blocks. */
export async function execSell(
  keys: Keys,
  token: { tokenId: string; decimals: number; poolXno: string; poolTokens: string },
  tokenAmount: string,
  slipPctRaw: number
): Promise<string> {
  const raw = toRaw(tokenAmount, token.decimals);
  const slipPct = Math.min(100, Math.max(0, Number.isFinite(slipPctRaw) ? slipPctRaw : 0));
  if (raw <= 0n) throw new Error("enter token amount");
  if (slipPct > 0) {
    const expected = quoteSell(token.poolXno, token.poolTokens, raw);
    const minXno = (expected * BigInt(Math.round((100 - slipPct) * 100))) / 10000n;
    const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "sell", tokens: raw, minXno });
    await submitLink(keys, fragA, 1n);
    return submitLink(keys, fragB, 1n);
  }
  return sendOp(keys, token.tokenId, { kind: "sell", tokens: raw, minXno: 0n });
}

export async function execTransfer(
  keys: Keys,
  token: { tokenId: string; decimals: number },
  to: string,
  tokenAmount: string
): Promise<string> {
  const raw = toRaw(tokenAmount, token.decimals);
  if (!isNanoAddr(to)) throw new Error("recipient must be a valid nano_ address");
  if (raw <= 0n) throw new Error("enter amount");
  const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "transfer", to, amount: raw });
  await submitLink(keys, fragA, 1n);
  return submitLink(keys, fragB, 1n);
}

/** Receive every pending block so incoming XNO becomes spendable. Opens the
 * account with the first block if unopened. Returns count received. */
export async function receiveAll(keys: Keys): Promise<{ count: number; balance: string }> {
  const r = await rpc("receivable", { account: keys.address, count: "20", source: "true" });
  const blocks = r.blocks && typeof r.blocks === "object" ? r.blocks : {};
  const hashes = Object.keys(blocks);
  let info: any = null;
  try {
    info = await rpc("account_info", { account: keys.address, representative: "true" });
  } catch {}
  let previous: string | null = info?.frontier ?? null;
  let balance = BigInt(info?.balance ?? "0");
  const representative = info?.representative ?? keys.address;
  let count = 0;
  for (const hash of hashes) {
    const entry: any = (blocks as any)[hash];
    const amount = BigInt(typeof entry === "string" ? entry : entry.amount);
    if (amount <= 0n) continue;
    balance += amount;
    const work = (await rpc("work_generate", { hash: previous ?? keys.publicKey, difficulty: RECEIVE_DIFF })).work;
    const blk = buildBlock(keys.secretKey, {
      work,
      previous,
      representative,
      balance: balance.toString(),
      link: hash,
    });
    const res = await rpc("process", { json_block: "true", block: blk });
    previous = res.hash;
    count++;
  }
  return { count, balance: balance.toString() };
}

export function keysFromSeed(seed: string): Keys {
  const secretKey = nanocurrency.deriveSecretKey(seed, 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address };
}

export async function fetchXnoBalance(account: string): Promise<string> {
  try {
    const info = await rpc("account_info", { account });
    return info.balance ?? "0";
  } catch {
    return "0";
  }
}
