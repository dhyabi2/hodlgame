"use client";

import { useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import * as nanocurrency from "nanocurrency";
import dynamic from "next/dynamic";
import { encodeOpLink } from "../core/oplink";
import { tokenIdFromLaunchHash } from "../core/token";

import { metaFieldsHash, metaSignDigest } from "../core/metaAuth";
import { commentSignDigest } from "../core/commentAuth";
import { ANCHOR_PUB } from "../core/anchor";
import { encodeFragLinks } from "../core/fraglink";
import { sanitizeMeta } from "../server/validate";
import type { Op } from "../core/ops";
import { Sparkline } from "./components/Sparkline";
import Explorer from "./components/Explorer";
import HalftoneGenome from "./components/HalftoneGenome";
import { loadWallet, saveWallet, removeWallet, encryptSeed, decryptSeed, saveSessionKeys, loadSessionKeys, clearSessionKeys } from "./lib/wallet";
import { useNanoWebsocket } from "./lib/nano-ws";
import { QRCodeSVG } from "qrcode.react";
import { toRaw, clampSlippage, isNanoAddr, fmtNum, fmtXno, fmtXnoPlain } from "./lib/trade";
import { shareCard, svgQrToCanvas } from "./lib/sharecard";
import { useXnoUsd, fmtUsd } from "./lib/usd";
import Welcome, { useTermsAccepted } from "./components/Welcome";
import { LogoWord, LogoMark } from "./components/Logo";

const PriceChart = dynamic(() => import("./components/PriceChart"), { ssr: false });

interface Keys {
  secretKey: string;
  publicKey: string;
  address: string;
}

interface PricePoint {
  time: number;
  priceRaw: string;
  marketCapRaw: string;
}

interface Trade {
  kind: "buy" | "sell";
  account: string;
  amountRaw: string;
  priceRaw: string;
  time: number;
}

interface Holder {
  account: string;
  balanceRaw: string;
  pct: number;
}

interface Comment {
  id: string;
  tokenId: string;
  account: string;
  text: string;
  time: number;
}

interface Token {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  creator: string;
  creatorShare: string;
  supply: string;
  treasury: string;
  poolXno: string;
  poolTokens: string;
  price: string;
  marketCap: string;
  change1h: number | null;
  change24h: number | null;
  createdAt: number;
  myBalance: string;
  myCredit: string;
  direct: boolean;
  myEarmark: string;
  myFloor: string;
  myQueueOwed: string;
  myPrepaid: string;
  queueTotal: string;
  totalFloor: string;
  queueHead: { account: string; owedRaw: string } | null;
  coveragePct: number | null;
  myStaked: string;
  myClaimable: string;
  totalStaked: string;
  buyVolume: string;
  sellVolume: string;
  holders: number;
  pool: string | null;
  spark: PricePoint[];
  series: PricePoint[];
  trades: Trade[];
  topHolders: Holder[];
  comments: Comment[];
}

function keysFromSeed(seed: string): Keys {
  const secretKey = nanocurrency.deriveSecretKey(seed, 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address };
}

// Auto-resize an uploaded image to fit within `maxDim` px on its longest side
// and re-encode as PNG via a canvas. This is the real "resize by dimension":
// it normalizes any format (jpeg/png/gif/webp) to PNG, strips EXIF/metadata,
// keeps aspect ratio, and shrinks the payload so a token avatar is a few KB
// regardless of the source resolution. Falls back to the original on any error.
async function resizeImageFile(file: File, maxDim = 512): Promise<{ blob: Blob; w: number; h: number }> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("could not read file"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("not a valid image"));
    i.src = dataUrl;
  });
  if (!img.width || !img.height) throw new Error("image has no dimensions");
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png")
  );
  return { blob, w, h };
}

// Monochrome Maker: convert a coin image to the HodlGame black-&-white brand
// look (grayscale + a firm S-curve contrast) so every coin is instantly
// recognizable as one of ours in any feed or share card. Keeps detail — not a
// brutal 1-bit threshold. Returns a fresh PNG blob; opt-out toggle in create.
async function monochromeBlob(src: Blob): Promise<Blob> {
  const url = URL.createObjectURL(src);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("bad image"));
      i.src = url;
    });
    const w = img.width || 1;
    const h = img.height || 1;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unsupported");
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      // S-curve around mid-gray → stark but not detail-destroying B/W.
      const v = 255 / (1 + Math.exp(-(luma - 128) / 34));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png")
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function genSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function rpc(action: string, params: Record<string, unknown>) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...params }),
  });
  const j = await res.json();
  if (j.error) {
    // An unfunded Nano account doesn't exist on the ledger yet, so account_info
    // returns "Account not found". Treat that as unopened/zero (callers show a
    // "fund it first" prompt) rather than surfacing a raw RPC error.
    if (action === "account_info" && /account not found|account not opened|not found/i.test(String(j.error))) {
      return { frontier: null, balance: "0", unopened: true };
    }
    throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
  }
  return j;
}

function buildBlock(
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

const fmtTok = (raw: string | undefined, dec: number) => {
  if (!raw) return "0";
  const n = BigInt(raw);
  const d = 10n ** BigInt(dec);
  const whole = n / d;
  const frac = (n % d).toString().padStart(dec, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole.toString();
};

function timeAgo(ts: number) {
  const t = ts > 1e12 ? ts : ts * 1000; // ms vs s
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const short = (a: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const pctStr = (n: number | null) => (n == null ? "·" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
// Fallback display when a token's off-chain metadata hasn't loaded yet, so a live
// coin is never fully blank — identify it by its tokenId.
const tokName = (t: { name: string; tokenId: string }) => t.name || `Coin ${t.tokenId.slice(0, 6)}`;
const tokSym = (t: { symbol: string; tokenId: string }) => t.symbol || t.tokenId.slice(0, 4).toUpperCase();

const quoteBuy = (poolXno: string, poolTokens: string, xno: bigint): bigint => {
  const px = BigInt(poolXno);
  const pt = BigInt(poolTokens);
  if (px <= 0n || pt <= 0n) return 0n;
  const afterFee = (xno * 9900n) / 10000n;
  return (afterFee * pt) / (px + afterFee);
};

// Mirror of state.ts direct-sell netting for previews/messages: how much
// settles instantly (prepay + own collateral released) vs queues for the
// next buys (post-coverage-haircut estimate).
function previewSellDirect(
  token: { poolXno: string; poolTokens: string; myPrepaid: string; myEarmark: string; myFloor: string; totalFloor: string; queueTotal: string },
  tokens: bigint,
  walletRaw: string
) {
  const out = quoteSell(token.poolXno, token.poolTokens, tokens);
  const pre = BigInt(token.myPrepaid || "0");
  const usePre = out < pre ? out : pre;
  let rem = out - usePre;
  const em = BigInt(token.myEarmark || "0");
  const bal = BigInt(walletRaw || "0");
  let net = rem < em ? rem : em;
  if (net > bal) net = bal;
  rem -= net;
  // Exact mirror of core/state.ts sell: credited = min(rem, max(0, num − Q))
  // where num = everyone-else's floors (totalFloor − myFloor) and Q = queueTotal.
  const num = BigInt(token.totalFloor || "0") - BigInt(token.myFloor || "0");
  const q = BigInt(token.queueTotal || "0");
  const headroom = num > q ? num - q : 0n;
  const queued = rem < headroom ? rem : headroom;
  return { total: out, instant: usePre + net, queued };
}

const quoteSell = (poolXno: string, poolTokens: string, tokens: bigint): bigint => {
  const px = BigInt(poolXno);
  const pt = BigInt(poolTokens);
  if (px <= 0n || pt <= 0n) return 0n;
  return (tokens * px) / (pt + tokens);
};


const inputC =
  "w-full rounded-none border border-neutral-800 bg-black px-4 py-3 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white";
const btn =
  "w-full rounded-none bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-black hover:bg-neutral-200 disabled:opacity-40 transition duration-200 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2";

function GitHubLink({ className = "" }: { className?: string }) {
  return (
    <a
      href="https://github.com/dhyabi2/hodlgame"
      target="_blank"
      rel="noreferrer"
      title="Open source on GitHub — verify the code yourself"
      className={"text-neutral-400 hover:text-white " + className}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-label="GitHub">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
  );
}

/** Bandwidth-friendly poller: self-scheduling (never overlaps — the next fetch
 * waits for the previous to finish PLUS the interval, so a slow ~4s endpoint
 * can't pile up), PAUSES entirely when the tab is hidden, and refreshes
 * immediately when the tab regains focus. Replaces raw setInterval, which fired
 * regardless of visibility or in-flight requests and hammered the server. */
function usePoll(fn: () => Promise<void> | void, intervalMs: number, deps: React.DependencyList) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const run = async () => {
      if (stopped || hidden()) return; // paused while backgrounded; visibilitychange resumes
      try { await fnRef.current(); } catch {}
      if (!stopped && !hidden()) timer = setTimeout(run, intervalMs);
    };
    run(); // one immediate load
    const onVis = () => { if (!hidden()) { clearTimeout(timer); run(); } };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearTimeout(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// The XNO balance is read independently by several cards (the connected-wallet
// card polls every 30s, the trade panel's MAX helper every 15s). A buy/sell is
// an OUTGOING send, so the incoming-deposit websocket never fires for it and
// each reader would otherwise sit on a stale balance until its own next poll —
// exactly the "I bought but my wallet still shows 1" report. This tiny bus lets
// any balance-mutating action (buy, sell, seed) ping every reader to re-read
// account_info at once. It fires immediately AND again after a short delay so a
// block the node processed but hasn't yet surfaced in account_info is still
// caught without waiting for a poll.
const walletDirtyListeners = new Set<() => void>();
function markWalletDirty() {
  const fire = () => { for (const fn of [...walletDirtyListeners]) { try { fn(); } catch {} } };
  fire();
  setTimeout(fire, 1500);
}
function useWalletDirty(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    walletDirtyListeners.add(h);
    return () => { walletDirtyListeners.delete(h); };
  }, []);
}

export default function Home() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false); // first /api/state response arrived
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Token | null>(null);
  const [detailMissing, setDetailMissing] = useState(false); // deep-linked coin confirmed unknown
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const usd = useXnoUsd(); // live XNO→USD for $-equivalents across the app
  // First-visit gate: the app is reachable only after the Terms are accepted.
  const [termsAccepted, acceptTerms] = useTermsAccepted();
  const [tab, setTab] = useState<"explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet">("explore");
  const [unlockOpen, setUnlockOpen] = useState(false);

  // Transient status message (auto-dismisses) — no persistent debug log in the UI.
  const say = (s: string) => { setToast(s); setTimeout(() => setToast((t) => (t === s ? "" : t)), 3500); };
  // One-tap unlock from anywhere: locked actions open an in-place sheet instead
  // of bouncing the user to the Wallet tab and losing their place.
  const promptUnlock = () => setUnlockOpen(true);

  const unlock = (k: Keys) => {
    setKeys(k);
    setHasWallet(true);
    // Persist for the browser session so a reload doesn't re-prompt (cleared on
    // tab close). Storing only the derived keys — the at-rest secret stays the
    // encrypted seed in localStorage.
    saveSessionKeys(JSON.stringify(k));
  };
  const lock = () => { setKeys(null); clearSessionKeys(); };
  const remove = () => {
    removeWallet();
    clearSessionKeys();
    setHasWallet(false);
    setKeys(null);
  };

  useEffect(() => {
    const hasW = Boolean(loadWallet());
    setHasWallet(hasW);
    // Restore an unlocked session across reloads (sessionStorage → cleared on
    // tab close). Only if the encrypted wallet still exists, and only a
    // well-formed key record — anything off falls back to a normal unlock.
    if (hasW) {
      const sess = loadSessionKeys();
      if (sess) {
        try {
          const k = JSON.parse(sess) as Keys;
          if (/^[0-9a-fA-F]{64}$/.test(k?.secretKey ?? "") && /^nano_[13][0-9a-z]{59}$/.test(k?.address ?? "")) {
            setKeys(k);
          } else {
            clearSessionKeys();
          }
        } catch { clearSessionKeys(); }
      }
    } else {
      clearSessionKeys(); // no wallet on disk → drop any stale session
    }
    // Deep-link restore: #t=<tokenId> opens a coin directly (shareable);
    // #tab=<name> restores the last section. Survives refresh + sharing.
    try {
      const h = new URLSearchParams(window.location.hash.slice(1));
      const t = h.get("t");
      const tb = h.get("tab") as typeof tab | null;
      if (t) setSelectedId(t.toLowerCase());
      else if (tb && ["explore", "ranks", "portfolio", "create", "scan", "wallet"].includes(tb)) setTab(tb);
    } catch {}
  }, []);

  // Keep the URL hash in sync so refresh/back/share land in the same place.
  // Skip the very first run (mount) so it can't clobber a deep-linked #tab=/#t=
  // with the default tab before the restore effect's setState propagates.
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (!syncedOnce.current) { syncedOnce.current = true; return; }
    try {
      const hash = selectedId ? `t=${selectedId}` : `tab=${tab}`;
      window.history.replaceState(null, "", `#${hash}`);
    } catch {}
  }, [selectedId, tab]);

  // Feed — self-scheduling poll: pauses when the tab is hidden, never overlaps,
  // refreshes on focus. The full-world replay behind /api/state costs ~4s, so a
  // 15s cadence (was 4s, which ran back-to-back continuously) cuts server load
  // ~4x per open tab while staying live enough for a memecoin feed.
  usePoll(async () => {
    const acct = keys?.address ?? "";
    const j = await (await fetch(`/api/state?account=${acct}`)).json();
    setTokens(j.tokens ?? []);
    setFeedLoaded(true);
  }, 15000, [keys?.address]);

  // Detail — reset when nothing selected; otherwise poll (paused-when-hidden).
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailMissing(false); }
    else setDetailMissing(false);
  }, [selectedId]);
  const [detailTick, setDetailTick] = useState(0);
  const refreshDetail = () => setDetailTick((t) => t + 1); // force an immediate re-fetch (e.g. right after seeding)
  usePoll(async () => {
    if (!selectedId) return; // nothing open → no request
    const acct = keys?.address ?? "";
    const j = await (await fetch(`/api/token?token=${selectedId}&account=${acct}`)).json();
    if (j.token) { setDetail(j.token); setDetailMissing(false); }
    // A successful response with no token (HTTP 404 {error:"unknown token"}) is a
    // CONFIRMED miss — show a not-found card instead of loading forever.
    else if (j.error && !detail) setDetailMissing(true);
  }, 8000, [selectedId, keys?.address, detailTick]);

  /** One-time 1-raw hello to the protocol anchor, so any indexer discovers
   * this account from chain data alone (no operator watch-list). Best-effort:
   * a failed hello never blocks the op — discovery has an env fallback. */
  async function ensureHello(): Promise<void> {
    if (!keys) return;
    const flag = `holdfun-hello-${keys.address}`;
    try {
      if (localStorage.getItem(flag)) return;
    } catch {
      /* storage unavailable → attempt the hello each time; it's 1 raw */
    }
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return;
      const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
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
    } catch {
      /* best-effort */
    }
  }

  async function submitBlock(link: string, balanceDelta: bigint): Promise<string> {
    if (!keys) { promptUnlock(); throw new Error("unlock your wallet"); }
    await ensureHello();
    const info = await rpc("account_info", { account: keys.address, representative: "true" });
    if (!info.frontier) throw new Error("fund your wallet first — send XNO to your address, then try again");
    const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
    const balance = (BigInt(info.balance) - balanceDelta).toString();
    const blk = buildBlock(keys.secretKey, {
      work,
      previous: info.frontier,
      representative: info.representative,
      balance,
      link,
    });
    const r = await rpc("process", { json_block: "true", block: blk });
    return r.hash as string;
  }

  async function sendOp(tokenId: string, op: Op, label: string) {
    if (!keys) return promptUnlock();
    setBusy(true);
    try {
      const hash = await submitBlock(encodeOpLink(tokenId, op), 1n);
      say(`${label} ✓ ${hash.slice(0, 10)}…`);
    } catch (e: any) {
      say(`${label} failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (termsAccepted === null) return <main className="min-h-screen bg-black" />; // avoid a flash while the stored choice loads
  if (!termsAccepted) return <Welcome onAccept={acceptTerms} />;

  return (
    <main className="min-h-screen bg-black text-white pb-20 overflow-x-hidden">
      <header className={"sticky top-0 z-20 h-14 flex items-center bg-black/90 backdrop-blur border-b " + (!selectedId && tab === "explore" ? "border-transparent" : "border-neutral-800")}>
        <div className="w-full px-4 flex items-center gap-3 sm:gap-5">
          <button className="text-white shrink-0" title="HODLGAME" onClick={() => { setSelectedId(null); setTab("explore"); }}>
            <LogoWord height={16} className="hidden sm:block" />
            <LogoMark size={26} className="sm:hidden" />
          </button>
          {/* Desktop nav only — on mobile the bottom tab bar handles navigation. */}
          <nav className="hidden sm:flex items-center gap-4 text-xs font-bold uppercase tracking-wide text-neutral-400 min-w-0 overflow-x-auto">
            {([["explore", "Coins"], ["ranks", "Ranks"], ["scan", "Explorer"], ["wallet", "Wallet"]] as const).map(([id, label]) => (
              <button key={id} className={"whitespace-nowrap py-1 border-b-2 -mb-px " + (!selectedId && tab === id ? "text-white border-white" : "border-transparent hover:text-white")} onClick={() => { setSelectedId(null); setTab(id); }}>{label}</button>
            ))}
            <a className="hover:text-white whitespace-nowrap" href="/pro">Chart / Trade ↗</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <GitHubLink />
            <button
              className="rounded-none bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200"
              onClick={() => { setSelectedId(null); setTab("create"); }}
            >
              Create
            </button>
            {keys ? (
              <button
                className="text-xs text-neutral-300 font-mono hover:text-white"
                title="wallet"
                onClick={() => { setSelectedId(null); setTab("wallet"); }}
              >
                {short(keys.address)}
              </button>
            ) : (
              <button className="text-xs text-white font-bold uppercase tracking-wide" onClick={promptUnlock}>
                unlock
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="w-full px-4 py-5">
        {selectedId ? (
          detail ? (
            <div className="w-full">
              <TokenDetail
                token={detail}
                keys={keys}
                busy={busy}
                say={say}
                usd={usd}
                ensureHello={ensureHello}
                submitBlock={submitBlock}
                sendOp={sendOp}
                promptUnlock={promptUnlock}
                onBack={() => setSelectedId(null)}
                refreshDetail={refreshDetail}
              />
            </div>
          ) : detailMissing ? (
            // Confirmed-unknown coin (stale/broken shared link) — a clear
            // dead-end message with a way back, never an infinite loader.
            <div className="w-full max-w-3xl mx-auto">
              <button onClick={() => setSelectedId(null)} className="text-xs text-neutral-500 hover:text-white">← all coins</button>
              <div className="mt-4 rounded-none border border-neutral-800 bg-neutral-950 p-10 text-center">
                <p className="text-lg font-black text-white">Coin not found</p>
                <p className="mt-1 text-sm text-neutral-500">This link points to a coin that doesn’t exist (or hasn’t been indexed yet).</p>
                <button onClick={() => setSelectedId(null)} className="mt-4 rounded-none bg-white px-4 py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200">Browse all coins</button>
              </div>
            </div>
          ) : (
            // Deep-linked / just-selected coin whose detail is still loading — show
            // a loading card, never the empty "No coins yet" feed (which made a
            // shared coin link look broken).
            <div className="w-full max-w-3xl mx-auto">
              <button onClick={() => setSelectedId(null)} className="text-xs text-neutral-500 hover:text-white">← all coins</button>
              <div className="mt-4 rounded-none border border-neutral-800 bg-neutral-950 p-10 text-center text-neutral-500 animate-pulse">loading coin…</div>
            </div>
          )
        ) : tab === "explore" ? (
          <Feed tokens={tokens} loaded={feedLoaded} onSelect={(id) => setSelectedId(id)} myAddress={keys?.address} usd={usd} onCreate={() => setTab("create")} />
        ) : tab === "ranks" ? (
          <Ranks onSelect={(id) => setSelectedId(id)} myAddress={keys?.address} />
        ) : tab === "scan" ? (
          <Explorer />
        ) : tab === "create" ? (
          <div className="w-full max-w-xl mx-auto">
            <CreateToken
              busy={busy}
              setBusy={setBusy}
              say={say}
              keys={keys}
              submitBlock={submitBlock}
              promptUnlock={promptUnlock}
              onCreated={(id) => {
                setTab("explore");
                setSelectedId(id);
              }}
            />
          </div>
        ) : (
          <div className="w-full max-w-xl mx-auto space-y-4">
            <WalletPanel keys={keys} hasWallet={hasWallet} unlock={unlock} lock={lock} remove={remove} say={say} />
            {keys && <Portfolio tokens={tokens} onSelect={(id) => setSelectedId(id)} account={keys.address} sendOp={sendOp} busy={busy} usd={usd} />}
          </div>
        )}

      </div>

      {toast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-none border border-neutral-700 bg-neutral-950 text-white px-4 py-2 text-sm shadow-lg max-w-[90vw] truncate">
          {toast}
        </div>
      )}

      {/* Clear any open coin when switching tabs, else the coin detail (which
          takes render priority) stays on screen and the bottom nav looks dead. */}
      <TabBar tab={tab} setTab={(t) => { setSelectedId(null); setTab(t); }} />

      <UnlockModal
        open={unlockOpen}
        hasWallet={hasWallet}
        onClose={() => setUnlockOpen(false)}
        onUnlocked={(k) => { unlock(k); setUnlockOpen(false); }}
        goSetup={() => { setUnlockOpen(false); setSelectedId(null); setTab("wallet"); }}
      />
    </main>
  );
}

// In-place unlock sheet: the min-clicks path to signing. Any locked action (buy,
// sell, stake, create, header) opens this without navigating away, so the user
// keeps their place (and the coin they were looking at).
function UnlockModal({
  open, hasWallet, onClose, onUnlocked, goSetup,
}: {
  open: boolean;
  hasWallet: boolean;
  onClose: () => void;
  onUnlocked: (k: Keys) => void;
  goSetup: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setPw(""); setPw2(""); setErr(""); } }, [open]);
  if (!open) return null;

  const unlock = async () => {
    setBusy(true); setErr("");
    try {
      const w = loadWallet();
      if (!w) return setErr("no wallet on this device");
      const s = await decryptSeed(w, pw);
      if (!/^[0-9a-fA-F]{64}$/.test(s)) return setErr("wrong password");
      onUnlocked(keysFromSeed(s));
    } catch { setErr("wrong password"); }
    finally { setBusy(false); }
  };

  // Inline creation: a newcomer who clicked Buy on a shared coin link gets a
  // wallet in one step WITHOUT being navigated away from the coin.
  const create = async () => {
    if (pw.length < 6) return setErr("password must be ≥ 6 chars");
    if (pw !== pw2) return setErr("passwords do not match");
    setBusy(true); setErr("");
    try {
      const s = genSeed();
      saveWallet(await encryptSeed(s, pw));
      onUnlocked(keysFromSeed(s));
    } catch (e: any) { setErr(e?.message ?? "encryption failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full rounded-none sm:rounded-none border border-neutral-800 bg-neutral-950 p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-neutral-200">{hasWallet ? "Unlock wallet" : "Set up your wallet"}</p>
          <button className="text-neutral-500 hover:text-white text-lg leading-none" onClick={onClose}>×</button>
        </div>
        {hasWallet ? (
          <>
            <input
              className={inputC}
              type="password"
              placeholder="password"
              value={pw}
              autoFocus
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlock()}
            />
            {err && <p className="text-xs text-white">{err}</p>}
            <button className={btn} disabled={busy} onClick={unlock}>{busy ? "unlocking…" : "Unlock"}</button>
            <p className="text-[11px] text-neutral-500">decrypted in your browser — your seed never leaves it</p>
          </>
        ) : (
          <>
            <p className="text-xs text-neutral-400">Create your wallet right here — it’s generated and encrypted in your browser and never leaves it. Takes ten seconds; you stay on this coin.</p>
            <input
              className={inputC}
              type="password"
              placeholder="choose a password (≥ 6 chars)"
              value={pw}
              autoFocus
              onChange={(e) => setPw(e.target.value)}
            />
            <input
              className={inputC}
              type="password"
              placeholder="confirm password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
            {err && <p className="text-xs text-white">{err}</p>}
            <button className={btn} disabled={busy} onClick={create}>{busy ? "creating…" : "Create wallet"}</button>
            <p className="text-[11px] text-neutral-500">
              Back up your seed from the Wallet tab when you get a moment — it’s the only recovery.{" "}
              <button className="underline hover:text-white" onClick={goSetup}>import an existing seed instead →</button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// Rich connected-wallet card: live XNO balance, copy address, receive pending
// (auto-receives on unlock so funded XNO becomes spendable), and a
// password-gated seed backup — the one secret a user must save to recover.
function ConnectedWallet({
  keys,
  lock,
  remove,
  say,
}: {
  keys: Keys;
  lock: () => void;
  remove: () => void;
  say: (s: string) => void;
}) {
  const [balance, setBalance] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const receivingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [revealPw, setRevealPw] = useState("");
  const [revealed, setRevealed] = useState("");
  const [revealErr, setRevealErr] = useState("");

  const refresh = async () => {
    try {
      const info = await rpc("account_info", { account: keys.address });
      setBalance(info.balance ?? "0");
    } catch {
      setBalance("0"); // unopened account reports an error; treat as zero
    }
  };

  // Receive every pending block so incoming XNO becomes spendable. Opens the
  // account with the first block if it has never been used. Idempotent, and
  // guarded so the poll, the websocket, and the button can never run it
  // concurrently (which would fork the chain on a stale frontier).
  const receiveAll = async (announce = true) => {
    if (receivingRef.current) return;
    receivingRef.current = true;
    setReceiving(true);
    try {
      const r = await rpc("receivable", { account: keys.address, count: "20", source: "true" });
      const blocks = r.blocks && typeof r.blocks === "object" ? r.blocks : {};
      const hashes = Object.keys(blocks);
      if (hashes.length === 0) {
        if (announce) say("nothing to receive");
        await refresh();
        return;
      }
      let info: any = null;
      try {
        info = await rpc("account_info", { account: keys.address, representative: "true" });
      } catch {
        info = null; // unopened
      }
      let previous: string | null = info?.frontier ?? null;
      let balance = BigInt(info?.balance ?? "0");
      const representative = info?.representative ?? keys.address;
      let count = 0;
      for (const hash of hashes) {
        const entry: any = (blocks as any)[hash];
        const amount = BigInt(typeof entry === "string" ? entry : entry.amount);
        if (amount <= 0n) continue;
        balance += amount;
        const workHash = previous ?? keys.publicKey;
        const work = (await rpc("work_generate", { hash: workHash, difficulty: "fffffe0000000000" })).work;
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
      if (announce) say(`received ${count} deposit${count === 1 ? "" : "s"} ✓`);
      setBalance(balance.toString());
      if (count > 0) markWalletDirty(); // a receive changed the balance — refresh every reader now
    } catch (e: any) {
      if (announce) say("receive failed: " + (e?.message ?? e));
    } finally {
      receivingRef.current = false;
      setReceiving(false);
    }
  };

  useEffect(() => { refresh(); receiveAll(false); /* on unlock */ /* eslint-disable-next-line */ }, [keys.address]);
  // Any balance-mutating action anywhere (a buy/sell in the trade panel is an
  // OUTGOING send the websocket never sees) pings us to re-read immediately.
  useWalletDirty(refresh);
  // A live websocket already receives deposits instantly; this poll is only a
  // safety net for a missed frame, so 30s (was 8s) + pause-when-hidden is plenty.
  usePoll(() => receiveAll(false), 30000, [keys.address]);

  // Live deposit detection: the moment a send to us confirms on the Nano
  // websocket, auto-receive it — no waiting for the 8s poll. (verifyXNO pattern.)
  useNanoWebsocket(keys.address, keys.publicKey, (amountRaw) => {
    say(`incoming ${fmtXno(amountRaw)} XNO — receiving…`);
    receiveAll(true);
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keys.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const doReveal = async () => {
    setRevealErr("");
    try {
      const w = loadWallet();
      if (!w) return setRevealErr("no wallet stored");
      const s = await decryptSeed(w, revealPw);
      if (!/^[0-9a-fA-F]{64}$/.test(s)) return setRevealErr("wrong password");
      setRevealed(s);
      setRevealPw("");
    } catch {
      setRevealErr("wrong password");
    }
  };

  const closeReveal = () => {
    setReveal(false);
    setRevealed("");
    setRevealPw("");
    setRevealErr("");
  };

  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-5 space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] text-neutral-500 mb-1">balance</p>
          <p className="text-3xl font-black">{balance == null ? "…" : fmtXno(balance)} <span className="text-lg text-neutral-500">XNO</span></p>
        </div>
        {balance != null && BigInt(balance) > 0n && (
          <button
            className="shrink-0 rounded-none border border-neutral-700 px-3 py-2 text-[11px] font-black uppercase tracking-wide text-neutral-200 hover:border-white"
            onClick={async () => {
              // Proof-of-Solvency: a monochrome share card attesting the live
              // balance with a scannable QR of the account (address masked in
              // the text) — a scanner can look the account up on the ledger and
              // confirm it's real. (Balance is a live snapshot, not pinned to a
              // frontier — the card shows the amount at mint time.)
              const qrHost = document.getElementById(`solq-${keys.address}`)?.querySelector("svg") as SVGElement | null;
              const qr = await svgQrToCanvas(qrHost, 220);
              const masked = keys.address.slice(0, 12) + "…" + keys.address.slice(-6);
              await shareCard({
                filename: "hodlgame-proof-of-solvency.png",
                title: "Proof of Solvency",
                headline: `${fmtXno(balance)} XNO`,
                subline: "verified on Nano — no custody, no IOU",
                rows: [
                  { label: "account", value: masked },
                  { label: "network", value: "Nano (XNO)" },
                ],
                footer: "scan to verify · hodlgame.fun",
                qr,
              });
            }}
          >
            Share proof
          </button>
        )}
      </div>
      {/* Hidden verify-QR (address only — never the seed) used to render the
          share card; scanning it lets anyone query the ledger independently. */}
      <div id={`solq-${keys.address}`} className="hidden">
        <QRCodeSVG value={`nano:${keys.address}`} size={220} bgColor="#ffffff" fgColor="#000000" level="M" />
      </div>

      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-3">
        <p className="text-[11px] text-neutral-500 mb-2">your address · scan or send XNO here to fund</p>
        <div className="flex items-start gap-3">
          {/* QR stays black-on-white — scanners need the light quiet zone. */}
          <div className="shrink-0 border border-neutral-800 bg-white p-1.5">
            <QRCodeSVG value={`nano:${keys.address}`} size={112} bgColor="#ffffff" fgColor="#000000" level="M" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block text-xs font-mono text-neutral-300 break-all">{keys.address}</span>
            <button className="rounded-none bg-neutral-900 px-2.5 py-1.5 text-[11px] font-bold text-neutral-300 hover:bg-neutral-800" onClick={copy}>
              {copied ? "copied" : "copy address"}
            </button>
            <p className="text-[10px] text-neutral-500">deposits are detected live and received automatically</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className="rounded-none border border-neutral-800 py-3 text-sm font-bold text-neutral-200 hover:border-white disabled:opacity-40"
          disabled={receiving}
          onClick={() => receiveAll(true)}
        >
          {receiving ? "receiving…" : "Receive pending"}
        </button>
        <button
          className="rounded-none border border-neutral-800 py-3 text-sm font-bold text-neutral-200 hover:border-white"
          onClick={() => setReveal((v) => !v)}
        >
          Back up seed
        </button>
      </div>

      {reveal && (
        <div className="rounded-none border border-neutral-700 bg-neutral-900 p-3 space-y-2">
          <p className="text-[11px] text-white font-bold">Your seed is full control of this wallet. Never share it. Anyone with it can drain your funds.</p>
          {!revealed ? (
            <>
              <input className={inputC} type="password" placeholder="wallet password" value={revealPw} onChange={(e) => setRevealPw(e.target.value)} />
              {revealErr && <p className="text-xs text-white">{revealErr}</p>}
              <div className="flex gap-2">
                <button className={btn} onClick={doReveal}>Reveal seed</button>
                <button className="rounded-none border border-neutral-800 px-4 py-3 text-sm font-bold text-neutral-400" onClick={closeReveal}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-mono text-white break-all select-all bg-neutral-900 rounded-none p-2">{revealed}</p>
              <div className="flex gap-2">
                <button
                  className="rounded-none bg-neutral-900 px-4 py-2 text-sm font-bold text-neutral-200 hover:bg-neutral-800"
                  onClick={() => navigator.clipboard.writeText(revealed).catch(() => {})}
                >
                  Copy seed
                </button>
                <button className="rounded-none border border-neutral-800 px-4 py-2 text-sm font-bold text-neutral-400" onClick={closeReveal}>Hide</button>
              </div>
            </>
          )}
        </div>
      )}

      <button className="w-full rounded-none border border-neutral-800 px-4 py-3 text-sm font-bold text-neutral-200 hover:border-white" onClick={lock}>
        Lock
      </button>
    </div>
  );
}

function WalletPanel({
  keys,
  hasWallet,
  unlock,
  lock,
  remove,
  say,
}: {
  keys: Keys | null;
  hasWallet: boolean;
  unlock: (k: Keys) => void;
  lock: () => void;
  remove: () => void;
  say: (s: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [seed, setSeed] = useState("");
  const [mode, setMode] = useState<"create" | "import">("create");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (password.length < 6) return setErr("password must be ≥ 6 chars");
    if (password !== confirm) return setErr("passwords do not match");
    setBusy(true);
    try {
      const s = genSeed();
      saveWallet(await encryptSeed(s, password));
      unlock(keysFromSeed(s));
      setPassword("");
      setConfirm("");
      setErr("");
    } catch (e: any) {
      setErr(e?.message ?? "encryption failed");
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    setBusy(true);
    try {
      const w = loadWallet();
      if (!w) return setErr("no wallet found");
      const s = await decryptSeed(w, password);
      if (!/^[0-9a-fA-F]{64}$/.test(s)) return setErr("wrong password");
      unlock(keysFromSeed(s));
      setPassword("");
      setErr("");
    } catch {
      setErr("wrong password");
    } finally {
      setBusy(false);
    }
  }

  async function importSeed() {
    const s = seed.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(s)) return setErr("invalid 64-hex seed");
    if (password.length < 6) return setErr("password must be ≥ 6 chars");
    setBusy(true);
    try {
      saveWallet(await encryptSeed(s, password));
      unlock(keysFromSeed(s));
      setSeed("");
      setPassword("");
      setErr("");
    } catch (e: any) {
      setErr(e?.message ?? "encryption failed");
    } finally {
      setBusy(false);
    }
  }

  if (keys) {
    return <ConnectedWallet keys={keys} lock={lock} remove={remove} say={say} />;
  }

  if (hasWallet) {
    return (
      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-4 space-y-2">
        <p className="text-sm font-bold text-neutral-300">Open wallet</p>
        <input className={inputC} type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="text-xs text-white">{err}</p>}
        <div className="flex gap-2">
          <button className={btn} disabled={busy} onClick={open}>
            {busy ? "opening…" : "Open"}
          </button>
          <button className="rounded-none border border-neutral-800 px-4 py-3 text-sm font-bold text-white hover:border-white" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-4 space-y-2">
      <div className="flex gap-2">
        <button className={"px-4 py-2 rounded-none text-sm font-bold " + (mode === "create" ? "bg-white text-black" : "text-neutral-500")} onClick={() => setMode("create")}>
          Create
        </button>
        <button className={"px-4 py-2 rounded-none text-sm font-bold " + (mode === "import" ? "bg-white text-black" : "text-neutral-500")} onClick={() => setMode("import")}>
          Import seed
        </button>
      </div>
      {mode === "import" && (
        <input className={inputC} placeholder="seed (64 hex)" value={seed} onChange={(e) => setSeed(e.target.value)} />
      )}
      <input className={inputC} type="password" placeholder="password (≥ 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
      {mode === "create" && (
        <input className={inputC} type="password" placeholder="confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      )}
      {err && <p className="text-xs text-white">{err}</p>}
      <button className={btn} disabled={busy} onClick={mode === "create" ? create : importSeed}>
        {busy ? "encrypting…" : mode === "create" ? "Create wallet" : "Encrypt & unlock"}
      </button>
      <p className="text-[11px] text-neutral-500">seed is encrypted in your browser (PBKDF2 + AES-GCM) and never leaves it</p>
    </div>
  );
}

// Derived status surfaces (docs/GROWTH-MECHANICS.md §4): token / creator /
// holder leaderboards, recomputed from public state — status is earned, not
// decreed. Endogenous competition: the prize is visibility, which is free.
interface TokenRank { tokenId: string; name: string; symbol: string; image: string; price: string; marketCap: string; change24h: number | null; holders: number; volume: string; createdAt: number }
interface CreatorRank { account: string; tokenCount: number; holders: number; marketCap: string; volume: string; score: number; badges: string[]; topSymbols: string[] }
interface HolderRank { account: string; tokensHeld: number; value: string; badges: string[] }
interface LB { updatedAt: number; tokens: { byVolume: TokenRank[]; byGainers: TokenRank[]; byHolders: TokenRank[]; newest: TokenRank[] }; creators: CreatorRank[]; holders: HolderRank[]; holderCount?: number }

/** Privacy-preserving rarity tier from a holder's absolute rank in the full
 * population — status without exposing a raw balance. */
function rarityBand(rank: number, total: number): string {
  if (total <= 0) return "Holder";
  const p = (rank + 1) / total;
  if (p <= 0.001) return "Top 0.1%";
  if (p <= 0.01) return "Top 1%";
  if (p <= 0.1) return "Top 10%";
  if (p <= 0.25) return "Top 25%";
  if (p <= 0.5) return "Top 50%";
  return "Holder";
}

/** Nemesis Card — collapses the whole holders board into one personal chase:
 * the rival directly above you, the exact XNO gap + % you must gain to overtake,
 * and who is closing from below. Pure read off the already-computed rank ledger,
 * no new state. Turns an intimidating list into a rivalry you check back on. */
function NemesisCard({ holders, myAddress }: { holders: HolderRank[]; myAddress?: string }) {
  if (!myAddress) return null;
  const me = holders.findIndex((h) => h.account === myAddress);
  if (me < 0) return null; // not ranked yet
  const rival = me > 0 ? holders[me - 1] : null;
  const chaser = me < holders.length - 1 ? holders[me + 1] : null;
  const myVal = BigInt(holders[me].value);
  const gapPct = (target: bigint) => {
    if (myVal <= 0n) return null;
    const bps = ((target - myVal) * 10000n) / myVal;
    return Number(bps) / 100;
  };
  return (
    <div className="rounded-none border border-neutral-700 bg-neutral-950 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Your nemesis</p>
        <p className="text-[10px] font-mono text-neutral-500">rank #{me + 1}</p>
      </div>
      {rival ? (
        <div className="mt-2">
          <p className="text-sm">
            <span className="font-mono text-neutral-300">{short(rival.account)}</span>
            <span className="text-neutral-500"> is one rank above you.</span>
          </p>
          {(() => { const g = gapPct(BigInt(rival.value)); return g != null ? (
            <p className="mt-1 text-lg font-black tabular-nums text-white">+{fmtNum(g)}% <span className="text-xs font-normal text-neutral-500">to overtake</span></p>
          ) : null; })()}
          <p className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">gap: {fmtXno((BigInt(rival.value) - myVal).toString())} XNO</p>
        </div>
      ) : (
        <p className="mt-2 text-lg font-black text-white">You’re #1. Defend the throne. 👑</p>
      )}
      {chaser && (() => { const g = gapPct(BigInt(chaser.value)); return (
        <p className="mt-3 border-t border-neutral-800 pt-2 text-[11px] text-neutral-500">
          <span className="font-mono text-neutral-400">{short(chaser.account)}</span> is closing from below{g != null ? <> — {fmtNum(-g)}% behind</> : null}
        </p>
      ); })()}
    </div>
  );
}

function Ranks({ onSelect, myAddress }: { onSelect: (id: string) => void; myAddress?: string }) {
  const [lb, setLb] = useState<LB | null>(null);
  const [board, setBoard] = useState<"byVolume" | "byGainers" | "byHolders" | "newest">("byVolume");

  // Leaderboards runs its OWN full-world replay (~4s) — expensive. Ranks don't
  // move fast, so poll at 30s (was 8s) and pause when the tab is hidden.
  usePoll(async () => {
    const j = await (await fetch("/api/leaderboards")).json();
    if (!j.error) setLb(j);
  }, 30000, []);

  if (!lb) {
    return <div className="grid gap-3 sm:grid-cols-2"><Skel /><Skel /><Skel /><Skel /></div>;
  }
  const empty = lb.tokens.byVolume.length === 0;
  if (empty) {
    return (
      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-300">No ranks yet</p>
        <p className="text-sm mt-1">Launch and trade coins to climb the boards.</p>
      </div>
    );
  }

  const boards: { k: typeof board; label: string }[] = [
    { k: "byVolume", label: "Volume" },
    { k: "byGainers", label: "Gainers" },
    { k: "byHolders", label: "Holders" },
    { k: "newest", label: "New" },
  ];
  const rows = lb.tokens[board];

  return (
    <div className="space-y-4">
      <NemesisCard holders={lb.holders} myAddress={myAddress} />
      <div className="grid gap-4 lg:grid-cols-2">
        {/* token leaderboard */}
        <section className="rounded-none border border-neutral-800 bg-neutral-950 p-4">
          <div className="flex items-center gap-1 mb-3 overflow-x-auto">
            {boards.map((b) => (
              <button key={b.k}
                className={"rounded-none px-2.5 py-1 text-xs font-bold whitespace-nowrap " + (board === b.k ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
                onClick={() => setBoard(b.k)}>{b.label}</button>
            ))}
          </div>
          <div className="space-y-1">
            {rows.map((t, i) => (
              <button key={t.tokenId} onClick={() => onSelect(t.tokenId)}
                className="flex w-full items-center gap-3 rounded-none px-2 py-2 text-left hover:bg-neutral-900">
                <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
                <Avatar image={t.image} symbol={tokSym(t)} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold truncate">{tokSym(t)} <span className="text-[11px] font-normal text-neutral-500">{tokName(t)}</span></p>
                  <p className="text-[11px] text-neutral-500 truncate">mc {fmtXno(t.marketCap)} XNO · {t.holders} holder{t.holders === 1 ? "" : "s"} · vol {fmtXno(t.volume)} XNO</p>
                </div>
                <span className={"text-xs font-bold tabular-nums shrink-0 " + (t.change24h == null ? "text-neutral-500" : t.change24h >= 0 ? "text-green-500" : "text-red-500")}>{pctStr(t.change24h)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* creators */}
        <section className="rounded-none border border-neutral-800 bg-neutral-950 p-4">
          <p className="text-sm font-bold text-neutral-300 mb-3">Top creators</p>
          <div className="space-y-1">
            {lb.creators.map((c, i) => (
              <div key={c.account} className={"flex items-center gap-3 rounded-none px-2 py-2 " + (c.account === myAddress ? "bg-neutral-900" : "")}>
                <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-mono text-neutral-300 truncate">{short(c.account)}{c.account === myAddress && <span className="text-white"> · you</span>}</p>
                  <p className="text-[11px] text-neutral-500 truncate">{c.tokenCount} coins · {c.holders} holders · {c.topSymbols.join(" ")}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <span className="text-xs font-black text-white tabular-nums">{c.score.toLocaleString()}</span>
                  {c.badges.length > 0 && <span className="text-[10px]">{c.badges.join(" ")}</span>}
                </div>
              </div>
            ))}
            {lb.creators.length === 0 && <p className="text-xs text-neutral-500 py-4 text-center">no creators yet</p>}
          </div>
        </section>
      </div>

      {/* holders — privacy-preserving rarity bands instead of raw balances */}
      <section className="rounded-none border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-bold text-neutral-300">Top holders</p>
          <p className="text-[10px] text-neutral-600">by rarity tier · {lb.holderCount ?? lb.holders.length} ranked</p>
        </div>
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {lb.holders.map((h, i) => {
            const band = rarityBand(i, lb.holderCount ?? lb.holders.length);
            const isMe = h.account === myAddress;
            return (
              <div key={h.account} className={"flex items-center gap-3 rounded-none px-2 py-1.5 " + (isMe ? "bg-neutral-900" : "")}>
                <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
                <p className="min-w-0 flex-1 text-sm font-mono text-neutral-300 truncate">{short(h.account)}{isMe && <span className="text-white"> · you</span>}</p>
                {h.badges.length > 0 && <span className="text-[10px] shrink-0">{h.badges.join(" ")}</span>}
                <span className={"shrink-0 rounded-none border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide " + (band.startsWith("Top 0") || band === "Top 1%" ? "border-white text-white" : "border-neutral-700 text-neutral-400")}>{band}</span>
              </div>
            );
          })}
          {lb.holders.length === 0 && <p className="text-xs text-neutral-500 py-4 text-center">no holders yet</p>}
        </div>
        <p className="mt-2 text-[10px] text-neutral-600">Ranked by tier, not raw balance — status without doxxing your bag.</p>
      </section>
    </div>
  );
}
const medal = (i: number) => (i === 0 ? "text-white" : i === 1 ? "text-neutral-300" : i === 2 ? "text-white" : "text-neutral-500");
function Skel() { return <div className="h-40 rounded-none bg-neutral-900 animate-pulse" />; }

/** Monochrome padlock — matches the stark black/white branding (currentColor). */
function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="inline-block shrink-0">
      <rect x="3.25" y="7" width="9.5" height="7" rx="0.5" />
      <path d="M5.25 7V4.75a2.75 2.75 0 0 1 5.5 0V7" />
    </svg>
  );
}

// Share glyph — two nodes joined to a hub, drawn in the same hairline stroke
// as LockIcon so it reads as part of the mono black/white system, not an emoji.
function ShareIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="inline-block shrink-0">
      <circle cx="12" cy="3.5" r="2" />
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="12.5" r="2" />
      <path d="M5.8 7 10.2 4.5M5.8 9l4.4 2.5" />
    </svg>
  );
}

/** Elegant loading skeleton for the Coins feed — a hero band + poster shelf +
 * grid mirroring the real layout, so the page doesn't jump when data lands. */
function FeedSkeleton() {
  return (
    <div className="space-y-10">
      <div className="h-10 w-full max-w-xs rounded-none bg-neutral-900 animate-pulse" />
      <div className="aspect-[16/6] w-full rounded-none bg-neutral-900 animate-pulse" />
      <div>
        <div className="mb-3 h-4 w-40 rounded-none bg-neutral-900 animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-none bg-neutral-900 animate-pulse" style={{ animationDelay: `${(i % 6) * 60}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Starting XNO-raw price of one whole token for a seed of (xnoRaw, tokenRaw). */
function priceOfSeed(xnoRaw: bigint, tokenRaw: bigint, decimals: number): bigint {
  if (tokenRaw <= 0n) return 0n;
  return (xnoRaw * 10n ** BigInt(decimals)) / tokenRaw;
}

/** The Unavoidable Pick — one coin surfaced per UTC day, chosen by a public,
 * future-unknowable seed = SHA-256(UTC-date · your address) indexed into the
 * eligible set. Nobody (us included) can curate or rig it toward/against you,
 * and anyone can recompute it. Provably-fair serendipity, not an opaque feed. */
function UnavoidablePick({ coins, myAddress, onSelect }: { coins: Token[]; myAddress?: string; onSelect: (id: string) => void }) {
  const [pick, setPick] = useState<Token | null>(null);
  const [show, setShow] = useState(false);
  const day = new Date().toISOString().slice(0, 10); // UTC date
  const seedStr = `${day}·${myAddress ?? "anon"}`;
  useEffect(() => {
    let live = true;
    if (coins.length === 0) { setPick(null); return; }
    (async () => {
      try {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seedStr));
        const n = new DataView(buf).getUint32(0);
        const sorted = [...coins].sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1)); // deterministic order
        if (live) setPick(sorted[n % sorted.length]);
      } catch { if (live) setPick(coins[0]); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedStr, coins.length]);
  if (!pick) return null;
  return (
    <div className="rounded-none border border-neutral-700 bg-neutral-950 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Today’s unavoidable pick</p>
        <button className="text-[10px] text-neutral-500 hover:text-white" onClick={() => setShow((v) => !v)}>{show ? "hide" : "verify"}</button>
      </div>
      <button onClick={() => onSelect(pick.tokenId)} className="mt-2 flex w-full items-center gap-3 text-left group">
        <Avatar image={pick.image} symbol={tokSym(pick)} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black truncate group-hover:underline">{tokSym(pick)} <span className="text-[11px] font-normal text-neutral-500">{tokName(pick)}</span></p>
          <p className="text-[11px] text-neutral-500">mc {fmtXno(pick.marketCap)} XNO · chosen for you, not by us</p>
        </div>
        <span className="text-neutral-600 group-hover:text-white">→</span>
      </button>
      {show && (
        <p className="mt-2 border-t border-neutral-800 pt-2 text-[10px] font-mono text-neutral-500 break-all">
          pick = SHA256("{seedStr}") mod {coins.length}. Public seed, changes daily, recomputable by anyone — we can’t rig it.
        </p>
      )}
    </div>
  );
}

function Feed({ tokens, loaded = true, onSelect, myAddress, usd, onCreate }: { tokens: Token[]; loaded?: boolean; onSelect: (id: string) => void; myAddress?: string; usd: number | null; onCreate?: () => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"mc" | "price" | "change" | "vol" | "new">("mc");
  const [showZeroCap, setShowZeroCap] = useState(false);

  // Before the first /api/state response, show an elegant skeleton — never a
  // premature "No coins yet" flash while the ledger is still being replayed.
  if (!loaded && tokens.length === 0) return <FeedSkeleton />;

  // "Live" coins: named, funded, held by you, or traded. Hides only
  // fully-abandoned launches you don't hold.
  // A coin must carry an image to be shown (pre-image-fix test launches are
  // hidden everywhere) — unless YOU hold it, so owners can always reach it.
  const eligible = tokens.filter(
    (t) => (Boolean(t.image) && (Boolean(t.name || t.symbol) || BigInt(t.poolXno) > 0n || BigInt(t.buyVolume) > 0n)) || BigInt(t.myBalance) > 0n
  );
  // Zero-cap = no starting price set yet (market cap 0 / unseeded). Hidden by
  // default so the feed shows only real, tradeable coins — but you always see
  // ones you hold or created, and a button at the end reveals the rest.
  const isZeroCap = (t: Token) => BigInt(t.marketCap || "0") <= 0n;
  const mineOrMade = (t: Token) => BigInt(t.myBalance || "0") > 0n || (!!myAddress && t.creator === myAddress);
  const hiddenZeroCap = eligible.filter((t) => isZeroCap(t) && !mineOrMade(t));
  const live = showZeroCap ? eligible : eligible.filter((t) => !isZeroCap(t) || mineOrMade(t));

  // Search matches ANY identifying field (name / symbol / tokenId) across all
  // tokens, so a coin is findable even before its metadata loads.
  const q = query.trim().toLowerCase();
  const searched = q
    ? tokens.filter((t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.tokenId.toLowerCase().includes(q))
    : null;

  const sorted = [...live].sort((a, b) => {
    switch (sort) {
      case "price": return BigInt(b.price) > BigInt(a.price) ? 1 : -1;
      case "change": return (b.change24h ?? -1e9) - (a.change24h ?? -1e9);
      case "vol": return BigInt(b.buyVolume) > BigInt(a.buyVolume) ? 1 : -1;
      case "new": return b.createdAt - a.createdAt;
      default: return BigInt(b.marketCap) > BigInt(a.marketCap) ? 1 : -1;
    }
  });

  // Browse rows (Netflix-style shelves, still minimal): trending by volume,
  // fresh launches, and biggest movers. The hero is the most-traded coin.
  const byVol = [...live].sort((a, b) => (BigInt(b.buyVolume) > BigInt(a.buyVolume) ? 1 : -1));
  const featured = byVol.find((t) => BigInt(t.buyVolume) > 0n) ?? sorted[0];
  const trending = byVol.filter((t) => BigInt(t.buyVolume) > 0n).slice(0, 12);
  const fresh = [...live].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  const movers = live.filter((t) => t.change24h != null).sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0)).slice(0, 12);
  // "Your Coins" — the continue-watching slot: shown first when non-empty.
  const mine = live.filter((t) => BigInt(t.myBalance) > 0n);

  // SEE ALL → jump to the All-coins grid pre-sorted for that shelf.
  const seeAll = (s: typeof sort) => {
    setSort(s);
    try { document.getElementById("all-coins")?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}
  };

  const SORTS: { k: typeof sort; label: string }[] = [
    { k: "mc", label: "Market cap" },
    { k: "price", label: "Price" },
    { k: "change", label: "24h change" },
    { k: "vol", label: "Volume" },
    { k: "new", label: "Newest" },
  ];

  // No coins at all, OR coins exist but every one was filtered out (e.g. all
  // imageless) and the user isn't searching — either way show the CTA instead
  // of empty shelves that read as a broken/half-loaded page.
  if (tokens.length === 0 || (live.length === 0 && !searched)) {
    return (
      <div className="bg-neutral-950 py-16 text-center space-y-4">
        <p className="text-3xl sm:text-5xl font-black uppercase tracking-tight text-white">No coins yet</p>
        <p className="text-[10px] uppercase tracking-[0.3em] text-neutral-500">Launch the first one on Nano</p>
        <button
          className="rounded-none bg-white px-5 py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200"
          onClick={onCreate}
        >
          Launch a coin
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="relative w-full max-w-xs">
        <svg aria-hidden viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          className="w-full rounded-none border border-neutral-800 bg-black py-2.5 pl-9 pr-3 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white"
          placeholder="Search coins…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {searched ? (
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">{searched.length} coin{searched.length === 1 ? "" : "s"} match</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {searched.map((t) => <PosterCard key={t.tokenId} t={t} usd={usd} onSelect={onSelect} />)}
          </div>
        </div>
      ) : (
        <>
          <UnavoidablePick coins={live} myAddress={myAddress} onSelect={onSelect} />
          {featured && <HeroCard t={featured} usd={usd} onSelect={onSelect} />}
          {mine.length > 0 && <FeedRow title="Your Coins" tokens={mine} usd={usd} onSelect={onSelect} />}
          {trending.length > 0 && <FeedRow title="Trending Now" tokens={trending} usd={usd} onSelect={onSelect} onSeeAll={() => seeAll("vol")} />}
          {movers.length > 0 && <FeedRow title="Top Movers" tokens={movers} usd={usd} onSelect={onSelect} onSeeAll={() => seeAll("change")} ranked />}
          {fresh.length > 0 && <FeedRow title="New Launches" tokens={fresh} usd={usd} onSelect={onSelect} onSeeAll={() => seeAll("new")} />}

          <div id="all-coins" className="space-y-3 scroll-mt-16">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] text-neutral-300">All coins</h2>
              <div className="hidden sm:flex border border-neutral-800 divide-x divide-neutral-800">
                {SORTS.map((s) => (
                  <button
                    key={s.k}
                    className={"px-3 py-1.5 text-[10px] font-black uppercase tracking-wide " + (sort === s.k ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
                    onClick={() => setSort(s.k)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <select
                className="sm:hidden rounded-none border border-neutral-800 bg-black px-3 py-1.5 text-xs uppercase text-neutral-300"
                value={sort}
                onChange={(e) => setSort(e.target.value as any)}
              >
                <option value="mc">market cap</option>
                <option value="price">price</option>
                <option value="change">24h change</option>
                <option value="vol">volume</option>
                <option value="new">newest</option>
              </select>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
              {sorted.map((t) => <PosterCard key={t.tokenId} t={t} usd={usd} onSelect={onSelect} />)}
            </div>
            {/* Zero-cap coins (no starting price yet) are hidden by default;
                reveal them on demand at the very end. */}
            {(hiddenZeroCap.length > 0 || showZeroCap) && (
              <div className="pt-3 text-center">
                <button
                  className="rounded-none border border-neutral-800 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-neutral-400 hover:border-white hover:text-white"
                  onClick={() => setShowZeroCap((v) => !v)}
                >
                  {showZeroCap ? "Hide zero-cap coins" : `Show ${hiddenZeroCap.length} zero-cap coin${hiddenZeroCap.length === 1 ? "" : "s"}`}
                </button>
                {!showZeroCap && <p className="mt-1 text-[10px] text-neutral-600">no starting price set yet — not tradeable</p>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Big cover image (or a bold monogram when the coin has none). */
function PosterImage({ t, className }: { t: Token; className: string }) {
  // Advance through the IPFS gateway list on each error (like Avatar) instead of
  // giving up after the first — a slow/down gateway no longer forces the
  // monogram when a working mirror exists.
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [t.image]);
  const candidates = t.image ? imageCandidates(t.image) : [];
  if (candidates.length > 0 && idx < candidates.length) {
    return <img src={candidates[idx]} alt="" className={className + " object-cover"} onError={() => setIdx((i) => i + 1)} />;
  }
  // Imageless fallback: a Halftone Genome — a deterministic B&W portrait unique
  // to this coin (never shown for coins that HAVE an uploaded image). The symbol
  // sits over it. A livelier coin (more volume) reads denser.
  const metric = Math.min(1, Math.log10(1 + Number(BigInt(t.buyVolume || "0")) / 1e28) / 3);
  return (
    <div className={className + " relative overflow-hidden bg-neutral-950 flex items-center justify-center"}>
      <div className="absolute inset-0"><HalftoneGenome tokenId={t.tokenId} size={300} metric={metric} className="h-full w-full opacity-70" /></div>
      <span className="relative font-black text-white text-3xl tracking-tight drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">{tokSym(t).slice(0, 3)}</span>
    </div>
  );
}

/** Netflix-style poster: full-color art, opaque black data footer — data never sits on imagery. */
function PosterCard({ t, usd, onSelect }: { t: Token; usd: number | null; onSelect: (id: string) => void }) {
  return (
    <button
      onClick={() => onSelect(t.tokenId)}
      className="group relative w-full text-left rounded-none bg-neutral-950 overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
    >
      <div className="relative aspect-square w-full overflow-hidden">
        <PosterImage t={t} className="w-full h-full opacity-90 transition duration-300 ease-out group-hover:opacity-100 group-hover:scale-105 motion-reduce:transition-none motion-reduce:transform-none" />
        {t.change24h == null ? (
          <span className="absolute top-2 right-2 bg-white px-1.5 py-0.5 text-[10px] font-black text-black">NEW</span>
        ) : (
          <span className={"absolute top-2 right-2 bg-black px-1.5 py-0.5 text-[10px] font-black tabular-nums " + (t.change24h >= 0 ? "text-green-500" : "text-red-500")}>
            {pctStr(t.change24h)}
          </span>
        )}
      </div>
      <div className="p-2.5 bg-neutral-950">
        <div className="flex items-baseline justify-between gap-1">
          <p className="font-bold text-sm text-white truncate">{tokName(t)}</p>
          <p className="text-[10px] uppercase text-neutral-500 shrink-0">${tokSym(t)}</p>
        </div>
        <div className="flex items-baseline justify-between gap-1">
          <p className="text-xs font-bold tabular-nums text-white truncate">{fmtXno(t.price)} XNO{usd != null && <span className="font-normal text-neutral-500"> · {fmtUsd(t.price, usd)}</span>}</p>
          <span aria-hidden className="text-xs text-neutral-500 group-hover:text-white shrink-0">→</span>
        </div>
        <p className="text-[10px] uppercase tracking-wide text-neutral-500 truncate">
          <span title="Market cap">MC {fmtXno(t.marketCap)}</span>{usd != null && <> ({fmtUsd(t.marketCap, usd)})</>} · {t.holders} holder{t.holders === 1 ? "" : "s"}
        </p>
      </div>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 hidden sm:block translate-y-full group-hover:translate-y-0 transition-transform duration-200 motion-reduce:transition-none motion-reduce:transform-none bg-white text-black text-[10px] font-black uppercase tracking-wide text-center py-1.5">
        Trade
      </span>
    </button>
  );
}

/** Horizontally-scrolling shelf of posters — Netflix row grammar: snap scroll,
 * visible prev/next arrows, SEE ALL, edge-cut cards + right-edge fade. */
function FeedRow({ title, tokens, usd, onSelect, onSeeAll, ranked }: { title: string; tokens: Token[]; usd: number | null; onSelect: (id: string) => void; onSeeAll?: () => void; ranked?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const page = (dir: number) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] text-neutral-300">{title}</h2>
        <div className="flex items-center gap-2">
          {onSeeAll && (
            <button className="text-[10px] font-black uppercase text-neutral-500 hover:text-white" onClick={onSeeAll}>
              See all →
            </button>
          )}
          <button aria-label={`scroll ${title} back`} className="hidden sm:flex h-7 w-7 items-center justify-center rounded-none border border-neutral-800 hover:border-white text-white text-sm" onClick={() => page(-1)}>‹</button>
          <button aria-label={`scroll ${title} forward`} className="hidden sm:flex h-7 w-7 items-center justify-center rounded-none border border-neutral-800 hover:border-white text-white text-sm" onClick={() => page(1)}>›</button>
        </div>
      </div>
      <div className="relative -mx-4">
        <div ref={trackRef} className="flex gap-2 overflow-x-auto snap-x snap-mandatory scroll-px-4 pb-2 px-4 scrollbar-hidden">
          {tokens.map((t, i) => (
            <div key={t.tokenId} className="w-40 sm:w-48 shrink-0 snap-start">
              {ranked ? (
                <div className="relative">
                  <span aria-hidden className="absolute -left-1 bottom-14 z-0 text-7xl font-black leading-none text-transparent [-webkit-text-stroke:2px_#404040] select-none">{i + 1}</span>
                  <div className="relative z-10 ml-8">
                    <PosterCard t={t} usd={usd} onSelect={onSelect} />
                  </div>
                </div>
              ) : (
                <PosterCard t={t} usd={usd} onSelect={onSelect} />
              )}
            </div>
          ))}
        </div>
        {/* Edge fade over black chrome only — signals overflow without hiding data. */}
        <div aria-hidden className="pointer-events-none absolute right-0 inset-y-0 w-12 bg-gradient-to-l from-black to-transparent" />
      </div>
    </div>
  );
}

/** Featured coin billboard: blurred/dimmed ambient art, content on effectively
 * solid black, one solid-white primary CTA. Data never sits on legible artwork. */
function HeroCard({ t, usd, onSelect }: { t: Token; usd: number | null; onSelect: (id: string) => void }) {
  const ch = t.change24h;
  return (
    <div className="relative w-full overflow-hidden rounded-none bg-black">
      {/* Ambient layer only — blur + dim means text sits on effectively solid black. */}
      <PosterImage t={t} className="absolute inset-0 w-full h-full scale-110 blur-2xl opacity-30" />
      <div className="relative flex flex-col sm:flex-row items-stretch gap-4">
        <div className="flex-1 min-w-0 flex flex-col justify-center p-6 sm:p-8">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-neutral-400">Featured</p>
          <div className="mt-1 flex items-baseline gap-3 min-w-0">
            <h2 className="text-4xl sm:text-6xl font-black tracking-tight text-white leading-none truncate">{tokName(t)}</h2>
            <span className="text-sm sm:text-base text-neutral-400 shrink-0">${tokSym(t)}</span>
          </div>
          {t.description && <p className="mt-2 text-sm text-neutral-300 line-clamp-2 max-w-xl">{t.description}</p>}
          <div className="mt-4 grid grid-cols-3 divide-x divide-neutral-800 border-y border-neutral-800 text-center">
            <div className="py-2 min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Price</p>
              <p className="text-base font-black tabular-nums text-white truncate">{fmtXno(t.price)} XNO{usd != null && <span className="font-bold text-neutral-500"> {fmtUsd(t.price, usd)}</span>}</p>
            </div>
            <div className="py-2 min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">24h change</p>
              <p className={"text-base font-black tabular-nums " + (ch == null ? "text-neutral-500" : ch >= 0 ? "text-green-500" : "text-red-500")}>{pctStr(ch)}</p>
            </div>
            <div className="py-2 min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Market cap</p>
              <p className="text-base font-black tabular-nums text-white truncate">{fmtXno(t.marketCap)} XNO</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              className="rounded-none bg-white px-6 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
              onClick={() => onSelect(t.tokenId)}
            >
              Trade →
            </button>
            <button
              className="rounded-none border border-neutral-600 px-6 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:border-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              onClick={() => onSelect(t.tokenId)}
            >
              Details
            </button>
          </div>
        </div>
        {/* Sharp full-color artwork on its own opaque zone — never under text. */}
        <div className="hidden sm:block sm:w-64 sm:h-64 self-center mr-10 shrink-0">
          <PosterImage t={t} className="w-full h-full" />
        </div>
      </div>
    </div>
  );
}

function trendColor(points: PricePoint[]): string {
  // Direction is never encoded as two grays — the sparkline stroke is always
  // white; the adjacent signed green/red change badge carries direction.
  void points;
  return "#ffffff";
}

// Public IPFS gateways tried in order; images are stored as ipfs://CID so any
// gateway (or a community pin) can serve them — no single pinning account.
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

/** Resolve an image URL to an ordered candidate list (ipfs:// and legacy
 * gateway URLs fan out across gateways; anything else passes through). */
function imageCandidates(url: string): string[] {
  // Uploaded image, served by our own route. Stored either site-relative
  // (/api/image/<id>, current uploads) or as an ABSOLUTE URL baked in with
  // whatever domain/alias was live at upload time (older uploads, before the
  // route switched to relative — a *.vercel.app alias can later start
  // redirecting/protecting itself, breaking any old absolute URL pointing at
  // it forever). Either shape is normalized to the CURRENT origin's relative
  // path, so a domain change never breaks a previously-uploaded image again.
  const own = url.match(/^(?:https?:\/\/[^/]+)?\/api\/image\/([0-9a-f]{32})$/);
  if (own) return [`/api/image/${own[1]}`];
  const m =
    url.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/) ??
    url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?$/);
  if (m) return IPFS_GATEWAYS.map((g) => g + m[1] + (m[2] ?? ""));
  const safe = safeHref(url);
  return safe ? [safe] : [];
}

function Avatar({ image, symbol, size = 40 }: { image: string; symbol: string; size?: number }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [image]);
  const candidates = image ? imageCandidates(image) : [];
  if (idx < candidates.length) {
    return (
      <img
        src={candidates[idx]}
        alt=""
        style={{ width: size, height: size }}
        className="rounded-full object-cover shrink-0"
        onError={() => setIdx((i) => i + 1)}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="rounded-full bg-neutral-800 flex items-center justify-center font-black text-white shrink-0"
    >
      {(symbol || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}

function TokenDetail({
  token: rawToken,
  keys,
  busy,
  say,
  usd,
  submitBlock,
  ensureHello,
  sendOp,
  promptUnlock,
  onBack,
  refreshDetail,
}: {
  token: Token;
  keys: Keys | null;
  busy: boolean;
  say: (s: string) => void;
  usd: number | null;
  submitBlock: (link: string, delta: bigint) => Promise<string>;
  ensureHello: () => Promise<void>;
  sendOp: (tokenId: string, op: Op, label: string) => Promise<void>;
  promptUnlock: () => void;
  onBack: () => void;
  refreshDetail: () => void;
}) {
  // Optimistic seed override: the instant the creator sets a starting price, the
  // coin reads as tradeable in the UI (poolXno/price/mcap reflect the seed) even
  // before the indexer catches up — so the "set price" banner and buy-guard
  // clear immediately and the creator never re-seeds (which would double the
  // reserves). Cleared once the polled token shows real liquidity.
  const [seedOverride, setSeedOverride] = useState<{ poolXno: string; poolTokens: string } | null>(null);
  useEffect(() => { if (BigInt(rawToken.poolXno || "0") > 0n) setSeedOverride(null); }, [rawToken.poolXno]);
  const token: Token = (() => {
    if (!seedOverride || BigInt(rawToken.poolXno || "0") > 0n) return rawToken;
    const px = priceOfSeed(BigInt(seedOverride.poolXno), BigInt(seedOverride.poolTokens), rawToken.decimals);
    const mc = (px * BigInt(rawToken.supply || "0")) / 10n ** BigInt(rawToken.decimals);
    return { ...rawToken, poolXno: seedOverride.poolXno, poolTokens: seedOverride.poolTokens, price: px.toString(), marketCap: mc.toString() };
  })();

  const [amount, setAmount] = useState("");
  const [sellReceipt, setSellReceipt] = useState<{ tokens: bigint; xnoOut?: bigint } | null>(null); // paper-hands receipt on sell
  const [shared, setShared] = useState(false);
  // Share this coin via a REAL server route (/t/<id>) — not the #t= hash, which
  // crawlers never see. That route serves per-coin OG tags + a branded OG image,
  // so pasting the link anywhere (X, Telegram, Discord, iMessage) unfurls with
  // the coin's name, symbol and picture. Native share sheet on mobile; clipboard
  // copy with a toast everywhere else.
  const doShare = async () => {
    const url = `${typeof window !== "undefined" ? window.location.origin : "https://www.hodlgame.fun"}/t/${token.tokenId}`;
    const title = `${tokName(token)} ${token.symbol ? `($${tokSym(token)})` : ""} · HodlGame`.trim();
    // Symbol as a hashtag (alphanumerics only — hashtags can't contain $ or
    // spaces) so a paste onto X/Telegram is tag-searchable.
    const tag = (token.symbol || "").replace(/[^a-zA-Z0-9]/g, "");
    const text = `${tokName(token)} — a zero-custody memecoin on Nano. Trade it on HodlGame.${tag ? ` #${tag}` : ""}`;
    try {
      if (typeof navigator !== "undefined" && (navigator as any).share) {
        await (navigator as any).share({ title, text, url });
        return;
      }
    } catch { return; /* user cancelled the native sheet — do nothing */ }
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 1600);
      say("link copied — paste it anywhere, it unfurls with the coin's card");
    } catch {
      say(url);
    }
  };
  const [tab, setTab] = useState<"trade" | "thread">("trade");
  const [side, setSide] = useState<"buy" | "sell">("buy"); // lifted so the mobile action bar can pick a side
  // Default to a sane 1% slippage and remember the user's last choice, so they
  // don't re-set protection on every coin.
  const [slippage, setSlippage] = useState(() => {
    try { return localStorage.getItem("holdfun-slippage") ?? "1"; } catch { return "1"; }
  });
  useEffect(() => { try { localStorage.setItem("holdfun-slippage", slippage); } catch {} }, [slippage]);
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [seedXno, setSeedXno] = useState("");
  const [seedTokens, setSeedTokens] = useState("");
  const [seedTouched, setSeedTouched] = useState(false); // creator edited the fields
  const [xnoBal, setXnoBal] = useState("0");

  // Prefill a RECOMMENDED starting price for the creator so they can seed in one
  // click (still editable): the full treasury (all 95% tradeable supply) against
  // a 1 XNO virtual reserve — a low, sensible starting price/market cap. Only
  // fills an un-seeded coin, and never overwrites the creator's own edits.
  useEffect(() => {
    if (seedTouched) return;
    const isMine = keys?.address === token.creator;
    if (isMine && BigInt(token.poolXno || "0") <= 0n && BigInt(token.treasury || "0") > 0n) {
      setSeedXno("1");
      setSeedTokens(fmtTok(token.treasury, token.decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.tokenId, token.poolXno, token.treasury, keys?.address, seedTouched]);

  // Live XNO balance for the trade/seed MAX buttons — paused when hidden, 15s.
  useEffect(() => { if (!keys) setXnoBal("0"); }, [keys]);
  const readXnoBal = async () => {
    if (!keys) { setXnoBal("0"); return; }
    try { const i = await rpc("account_info", { account: keys.address }); setXnoBal(i.balance ?? "0"); }
    catch { setXnoBal("0"); }
  };
  usePoll(readXnoBal, 15000, [keys?.address, busy]);
  useWalletDirty(readXnoBal); // re-read the instant any buy/sell/seed/receive lands

  const myHolding = keys ? token.topHolders.find((h) => h.account === keys.address) : undefined;
  const isCreator = keys?.address === token.creator;

  async function buy() {
    if (!keys) return promptUnlock();
    if (token.direct) return buyDirect();
    if (!token.pool) return say("this token has no pool yet");
    const raw = toRaw(amount, 30);
    if (raw <= 0n) return say("enter XNO amount");
    try {
      // Announce this account to the anchor BEFORE the buy — holdings are
      // computed by replaying anchor-DISCOVERED accounts, and buy() was the
      // one op path that never sent the 1-raw hello, so a wallet whose first
      // action was a buy stayed invisible to the indexer (its purchase never
      // appeared in the wallet's holdings). Must run before account_info: the
      // hello advances the frontier.
      await ensureHello();
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("fund your wallet first — send XNO to your address, then try again");

      // 1. deposit: send XNO to the token's pool (the authoritative value).
      const w1 = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const blk1 = buildBlock(keys.secretKey, {
        work: w1,
        previous: info.frontier,
        representative: info.representative,
        balance: (BigInt(info.balance) - raw).toString(),
        link: token.pool,
      });
      const r1 = await rpc("process", { json_block: "true", block: blk1 });

      // 2. buy op chained directly after the deposit (previous = deposit hash).
      const slip = clampSlippage(slippage);
      let minTokens = 0n;
      if (slip > 0) {
        const expected = quoteBuy(token.poolXno, token.poolTokens, raw);
        minTokens = (expected * BigInt(Math.round((100 - slip) * 100))) / 10000n;
      }
      const opLink = encodeOpLink(token.tokenId, { kind: "buy", xno: 0n, minTokens });
      const w2 = (await rpc("work_generate", { hash: r1.hash, difficulty: "fffffff800000000" })).work;
      const blk2 = buildBlock(keys.secretKey, {
        work: w2,
        previous: r1.hash,
        representative: info.representative,
        balance: (BigInt(info.balance) - raw - 1n).toString(),
        link: opLink,
      });
      const r2 = await rpc("process", { json_block: "true", block: blk2 });
      say(`buy ✓ ${r2.hash.slice(0, 10)}…`);
      setAmount("");
      markWalletDirty();
    } catch (e: any) {
      say("buy failed: " + e.message);
    }
  }

  // Direct-Settlement buy: with a seller waiting, the XNO goes STRAIGHT to
  // their wallet (deposit send to the queue head + chained op). With no queue,
  // nothing moves at all — the amount stays in this wallet as collateral,
  // declared in a fragment pair the network checks against the signed balance.
  async function buyDirect() {
    if (!keys) return promptUnlock();
    const raw = toRaw(amount, 30);
    if (raw <= 0n) return say("enter XNO amount");
    if (BigInt(token.poolXno) <= 0n) return say(isCreator ? "set your starting price first — use the banner above (it's free, virtual reserve)" : "not tradeable yet — the creator hasn't set a starting price");
    const slip = clampSlippage(slippage);
    try {
      await ensureHello();
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("fund your wallet first — send XNO to your address, then try again");
      if (token.queueHead) {
        const owed = BigInt(token.queueHead.owedRaw);
        const pay = raw < owed ? raw : owed;
        const expected = quoteBuy(token.poolXno, token.poolTokens, pay);
        const minTokens = slip > 0 ? (expected * BigInt(Math.round((100 - slip) * 100))) / 10000n : 0n;
        const w1 = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
        const blk1 = buildBlock(keys.secretKey, {
          work: w1, previous: info.frontier, representative: info.representative,
          balance: (BigInt(info.balance) - pay).toString(),
          link: nanocurrency.derivePublicKey(token.queueHead.account),
        });
        const r1 = await rpc("process", { json_block: "true", block: blk1 });
        const w2 = (await rpc("work_generate", { hash: r1.hash, difficulty: "fffffff800000000" })).work;
        const blk2 = buildBlock(keys.secretKey, {
          work: w2, previous: r1.hash, representative: info.representative,
          balance: (BigInt(info.balance) - pay - 1n).toString(),
          link: encodeOpLink(token.tokenId, { kind: "buy", xno: 0n, minTokens }),
        });
        await rpc("process", { json_block: "true", block: blk2 });
        say(`buy ✓ — ${fmtXno(pay.toString())} XNO paid a waiting seller directly, wallet to wallet`);
      } else {
        const need = raw + BigInt(token.myFloor || "0") + 2n;
        if (BigInt(info.balance) < need) return say("not enough XNO — in a zero-custody coin your buy amount stays in YOUR wallet as collateral, so it must actually be there");
        const expected = quoteBuy(token.poolXno, token.poolTokens, raw);
        const minTokens = slip > 0 ? (expected * BigInt(Math.round((100 - slip) * 100))) / 10000n : 0n;
        const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "buy", xno: raw, minTokens });
        await submitBlock(fragA, 1n);
        await submitBlock(fragB, 1n);
        say("buy ✓ — your XNO never left your wallet; it now backs your position as collateral");
      }
      setAmount("");
      markWalletDirty();
    } catch (e: any) {
      say("buy failed: " + e.message);
    }
  }

  async function sell() {
    if (!keys) return promptUnlock();
    if (token.direct) return sellDirect();
    const raw = toRaw(amount, token.decimals);
    if (raw <= 0n) return say("enter token amount");
    setAmount("");
    const slip = clampSlippage(slippage);
    try {
      if (slip > 0) {
        const expected = quoteSell(token.poolXno, token.poolTokens, raw);
        const minXno = (expected * BigInt(Math.round((100 - slip) * 100))) / 10000n;
        // Fragment links: the full op goes on-chain across two chained blocks
        // (no off-chain commit registry). submitBlock chains B after A.
        const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "sell", tokens: raw, minXno });
        await submitBlock(fragA, 1n);
        await submitBlock(fragB, 1n);
        say("sold ✓ — XNO credited to your game balance. Withdraw any time.");
      } else {
        await sendOp(token.tokenId, { kind: "sell", tokens: raw, minXno: 0n }, "sell");
      }
      markWalletDirty();
      setSellReceipt({ tokens: raw });
    } catch (e: any) {
      say("sell failed: " + e.message);
    }
  }

  // Direct-Settlement sell: principal settles INSTANTLY by releasing the
  // seller's own collateral (their XNO never moved); only realized profit
  // queues, paid straight to their wallet by the next buys.
  async function sellDirect() {
    if (!keys) return promptUnlock();
    const raw = toRaw(amount, token.decimals);
    if (raw <= 0n) return say("enter token amount");
    const slip = clampSlippage(slippage);
    try {
      const p = previewSellDirect(token, raw, xnoBal);
      const guarded = p.instant + p.queued;
      const minXno = slip > 0 ? (guarded * BigInt(Math.round((100 - slip) * 100))) / 10000n : 0n;
      const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "sell", tokens: raw, minXno });
      await submitBlock(fragA, 1n);
      await submitBlock(fragB, 1n);
      const parts = [`${fmtXno(p.instant.toString())} XNO yours instantly (your collateral, released)`];
      if (p.queued > 0n) parts.push(`${fmtXno(p.queued.toString())} XNO queued — the next buys pay it straight to your wallet`);
      say(`sold ✓ — ${parts.join(" · ")}`);
      setAmount("");
      markWalletDirty();
      setSellReceipt({ tokens: raw, xnoOut: guarded });
    } catch (e: any) {
      say("sell failed: " + e.message);
    }
  }

  // Creator seeds/adds pool liquidity: deposit XNO to the pool (value-bound),
  // then a chained seedLiq op moving `tokens` from treasury into the pool. This
  // is what makes a launched token tradeable — mirrors the buy deposit+op flow.
  async function seed() {
    if (!keys) return promptUnlock();
    if (token.direct) return seedDirect();
    if (!token.pool) return say("no pool derived for this token yet");
    if (keys.address !== token.creator) return say("only the creator can seed liquidity");
    const xnoRaw = toRaw(seedXno, 30);
    const tokRaw = toRaw(seedTokens, token.decimals);
    if (xnoRaw <= 0n) return say("enter XNO amount to seed");
    if (tokRaw <= 0n) return say("enter token amount to seed");
    if (tokRaw > BigInt(token.treasury)) return say("token amount exceeds treasury");
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("fund your wallet first — send XNO to your address, then try again");
      const w1 = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const blk1 = buildBlock(keys.secretKey, {
        work: w1, previous: info.frontier, representative: info.representative,
        balance: (BigInt(info.balance) - xnoRaw).toString(), link: token.pool,
      });
      const r1 = await rpc("process", { json_block: "true", block: blk1 });
      const opLink = encodeOpLink(token.tokenId, { kind: "seedLiq", xno: 0n, tokens: tokRaw });
      const w2 = (await rpc("work_generate", { hash: r1.hash, difficulty: "fffffff800000000" })).work;
      const blk2 = buildBlock(keys.secretKey, {
        work: w2, previous: r1.hash, representative: info.representative,
        balance: (BigInt(info.balance) - xnoRaw - 1n).toString(), link: opLink,
      });
      const r2 = await rpc("process", { json_block: "true", block: blk2 });
      say(`liquidity seeded ✓ — trading is open`);
      markWalletDirty();
      setSeedOverride({ poolXno: xnoRaw.toString(), poolTokens: tokRaw.toString() });
      setSeedXno(""); setSeedTokens(""); setSeedTouched(true);
      refreshDetail();
      for (const ms of [3000, 7000, 14000, 25000]) setTimeout(refreshDetail, ms);
    } catch (e: any) {
      say("seed failed: " + e.message);
    }
  }

  // Direct token: the "seed" is a VIRTUAL starting reserve — a fragment pair
  // declaring the price curve. No deposit is taken and no pool account exists;
  // an inflated number only hurts the creator (their own exit has no
  // collateral behind it until real buyers commit).
  async function seedDirect() {
    if (!keys) return promptUnlock();
    if (keys.address !== token.creator) return say("only the creator can seed liquidity");
    const xnoRaw = toRaw(seedXno, 30);
    const tokRaw = toRaw(seedTokens, token.decimals);
    if (xnoRaw <= 0n) return say("enter the virtual XNO reserve (sets the starting price)");
    if (tokRaw <= 0n) return say("enter token amount to seed");
    if (tokRaw > BigInt(token.treasury)) return say("token amount exceeds treasury");
    try {
      const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "seedLiq", xno: xnoRaw, tokens: tokRaw });
      await submitBlock(fragA, 1n);
      const hash = await submitBlock(fragB, 1n);
      say(`starting price set ✓ — trading is open`);
      markWalletDirty();
      // Optimistically mark the coin tradeable NOW so the banner/buy-guard clear
      // and the creator never re-seeds while the indexer catches up.
      setSeedOverride({ poolXno: xnoRaw.toString(), poolTokens: tokRaw.toString() });
      setSeedXno(""); setSeedTokens(""); setSeedTouched(true);
      refreshDetail();
      for (const ms of [3000, 7000, 14000, 25000]) setTimeout(refreshDetail, ms);
    } catch (e: any) {
      say("seed failed: " + e.message);
    }
  }

  async function transfer() {
    if (!keys) return promptUnlock();
    const to = sendTo.trim();
    const raw = toRaw(sendAmount, token.decimals);
    if (!to || raw <= 0n) return say("enter recipient address + amount");
    if (!isNanoAddr(to)) return say("recipient must be a valid nano_ address");
    if (raw > BigInt(token.myBalance ?? "0")) return say(`you only hold ${fmtTok(token.myBalance, token.decimals)} ${tokSym(token)}`);
    try {
      const [fragA, fragB] = encodeFragLinks(token.tokenId, { kind: "transfer", to, amount: raw });
      await submitBlock(fragA, 1n);
      const hash = await submitBlock(fragB, 1n);
      say(`sent ✓ ${hash.slice(0, 10)}…`);
      setSendAmount("");
      setSendTo("");
    } catch (e: any) {
      say("send failed: " + e.message);
    }
  }

  // Mobile action bar → jump to (and reveal) the trade form on the chosen side.
  const goTrade = (s: "buy" | "sell") => {
    setSide(s);
    setTab("trade");
    try { document.getElementById("trade-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
  };

  const volumeRaw = (BigInt(token.buyVolume || "0") + BigInt(token.sellVolume || "0")).toString();

  // "Your Entry Line": the viewer's volume-weighted avg BUY price over their
  // own recent buy trades (token.trades stores buy size in TOKENS + priceRaw).
  // Purely client-side from data already on the token view — nobody else sees
  // it. Current price → live P&L delta.
  const myEntry = (() => {
    if (!keys) return { price: 0, pnl: null as number | null };
    let tok = 0, weighted = 0;
    for (const tr of token.trades) {
      if (tr.kind !== "buy" || tr.account !== keys.address) continue;
      const t = Number(BigInt(tr.amountRaw)) / 10 ** token.decimals;
      const px = Number(BigInt(tr.priceRaw)) / 1e30;
      if (t > 0 && Number.isFinite(px)) { tok += t; weighted += t * px; }
    }
    if (tok <= 0) return { price: 0, pnl: null };
    const price = weighted / tok;
    const cur = Number(BigInt(token.price || "0")) / 1e30;
    const pnl = price > 0 ? ((cur - price) / price) * 100 : null;
    return { price, pnl };
  })();

  return (
    <div className="space-y-4 pb-16 sm:pb-0">
      {sellReceipt && (
        <PaperHandsReceipt
          kind="sell"
          symbol={tokSym(token)}
          decimals={token.decimals}
          tokenId={token.tokenId}
          tokens={sellReceipt.tokens}
          xnoOut={sellReceipt.xnoOut}
          onRedeem={() => { setSellReceipt(null); setSide("buy"); }}
          onClose={() => setSellReceipt(null)}
        />
      )}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-[10px] font-black uppercase tracking-widest text-neutral-500 hover:text-white">← All coins</button>
        <a href={`/pro?token=${token.tokenId}`} className="rounded-none border border-neutral-800 px-2.5 py-1 text-[11px] font-bold text-white hover:border-white">
          Pro terminal ↗
        </a>
      </div>

      {/* Creator's coin isn't tradeable until they set a starting price — a
          prominent one-tap prompt so a freshly-launched coin never dead-ends
          on the "no starting price" trade error. */}
      {isCreator && BigInt(token.poolXno) <= 0n && (
        <div className="rounded-none border border-white bg-neutral-950 p-4">
          <p className="text-sm font-black text-white">One step left: set your starting price</p>
          <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
            Your coin is launched but not tradeable yet. Set a starting price to open trading —
            {token.direct ? " it's a virtual reserve, so no money leaves your wallet." : " seed the pool to make it tradeable."}
          </p>
          <button
            className="mt-3 rounded-none bg-white px-4 py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200"
            onClick={() => { setTab("trade"); setTimeout(() => document.getElementById("seed-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}
          >
            Set starting price →
          </button>
        </div>
      )}

      {/* Title-sequence band: full-color art as blurred/dimmed ambient backdrop,
          sharp square poster + banking-grade numbers on effectively solid black. */}
      <div className="relative overflow-hidden rounded-none bg-neutral-950 px-5 sm:px-8 py-8">
        <PosterImage t={token} className="absolute inset-0 w-full h-full blur-2xl scale-110 opacity-25" />
        <div className="relative">
          <div className="flex items-center gap-4">
            <PosterImage t={token} className="w-20 h-20 sm:w-24 sm:h-24 shrink-0 rounded-none border border-neutral-800" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-white truncate">{tokName(token)}</h2>
                <span className="text-sm text-neutral-400 shrink-0">${tokSym(token)}</span>
              </div>
              <button
                className="text-[11px] text-neutral-500 font-mono hover:text-neutral-300"
                title={`token id ${token.tokenId} — click to copy`}
                onClick={() => { try { navigator.clipboard.writeText(token.tokenId); } catch {} }}
              >
                {token.tokenId.slice(0, 6)}…{token.tokenId.slice(-4)} ⧉
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-baseline gap-3 flex-wrap">
            <p className="text-3xl font-black tabular-nums text-white">{fmtXno(token.price)} XNO</p>
            {usd != null && <p className="text-base tabular-nums text-neutral-400">{fmtUsd(token.price, usd)}</p>}
            <span className={"px-2 py-0.5 text-sm font-black tabular-nums bg-black border border-neutral-800 " + (token.change24h == null ? "text-neutral-500" : token.change24h >= 0 ? "text-green-500" : "text-red-500")}>
              {pctStr(token.change24h)}
            </span>
          </div>

          {token.description && <p className="text-sm text-neutral-300 mt-3">{token.description}</p>}
          <div className="flex items-center gap-3 mt-3">
            {token.website && <SocialLink href={token.website} label="website" />}
            {token.twitter && <SocialLink href={token.twitter} label="X" />}
            {token.telegram && <SocialLink href={token.telegram} label="telegram" />}
            {/* Small icon-only share, inline with the socials (native sheet on
                mobile, copy the /t/<id> unfurl link elsewhere). */}
            <button
              onClick={doShare}
              title={shared ? "link copied — it unfurls with the coin's card" : "share this coin"}
              aria-label="Share this coin"
              className="inline-flex items-center gap-1 text-[11px] text-white hover:text-neutral-300"
            >
              <ShareIcon size={13} />
              {shared && <span>copied</span>}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 border-y border-neutral-800 divide-x divide-neutral-800 text-center py-2">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Market cap</p>
              <p className="text-sm font-black tabular-nums text-white truncate">{fmtXno(token.marketCap)} XNO{usd != null && <span className="font-bold text-neutral-500"> ({fmtUsd(token.marketCap, usd)})</span>}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Volume</p>
              <p className="text-sm font-black tabular-nums text-white truncate">{fmtXno(volumeRaw)} XNO</p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Holders</p>
              <p className="text-sm font-black tabular-nums text-white">{token.holders}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-3 text-[11px] text-neutral-500 flex-wrap">
            <span>liquidity {fmtXno(token.poolXno)} XNO</span>
            <span>created {timeAgo(token.createdAt)} ago</span>
            <span>dev {short(token.creator)}</span>
          </div>
        </div>
      </div>

      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Price</p>
          <div className="flex items-center gap-3 text-[11px] text-neutral-500">
            <span>pool {fmtXno(token.poolXno)} XNO</span>
            <span>pool {fmtNum(Number(BigInt(token.poolTokens)) / 10 ** token.decimals)} {tokSym(token)}</span>
          </div>
        </div>
        {myEntry.price > 0 && (
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <span className="text-neutral-500 uppercase tracking-wide">Your entry <span className="normal-case">(recent buys)</span></span>
            <span className="font-mono text-neutral-300">{fmtNum(myEntry.price)} XNO</span>
            {myEntry.pnl != null && (
              <span className={"font-black tabular-nums " + (myEntry.pnl >= 0 ? "text-green-500" : "text-red-500")}>
                {myEntry.pnl >= 0 ? "+" : ""}{myEntry.pnl.toFixed(1)}%
              </span>
            )}
            <span className="text-neutral-600">· only you see this line</span>
          </div>
        )}
        {token.series.length >= 2 ? (
          <PriceChart series={token.series} trades={token.trades} decimals={token.decimals} symbol={tokSym(token)} entryPrice={myEntry.price} />
        ) : (
          <div className="h-40 flex items-center justify-center text-neutral-500 text-sm">no trades yet — the chart appears after the first buy</div>
        )}
        <ProgressBar token={token} />
      </div>

      <div id="trade-panel" className="rounded-none border border-neutral-800 bg-neutral-950 p-5">
        <div className="flex items-center gap-2 mb-3">
          <button
            className={"px-4 py-2 rounded-none text-sm font-bold " + (tab === "trade" ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
            onClick={() => setTab("trade")}
          >
            Trade
          </button>
          <button
            className={"px-4 py-2 rounded-none text-sm font-bold " + (tab === "thread" ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
            onClick={() => setTab("thread")}
          >
            Thread ({token.comments.length})
          </button>
        </div>
        {tab === "trade" ? (
          <TradePanel
            token={token}
            myHolding={myHolding}
            xnoBal={xnoBal}
            amount={amount}
            setAmount={setAmount}
            slippage={slippage}
            setSlippage={setSlippage}
            busy={busy}
            buy={buy}
            sell={sell}
            sendOp={sendOp}
            address={keys?.address ?? null}
            promptUnlock={promptUnlock}
            side={side}
            setSide={setSide}
          />
        ) : (
          <CommentThread tokenId={token.tokenId} comments={token.comments} keys={keys} isDev={keys?.address === token.creator} />
        )}
      </div>

      {isCreator && keys && <EditCoinInfo token={token} keys={keys} say={say} />}

      {isCreator && (
        <div id="seed-panel" className="rounded-none border border-neutral-600 bg-neutral-950 p-5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-white">{token.direct ? "Set starting price" : "Seed / add liquidity"} <span className="text-[11px] font-normal text-neutral-500">creator</span></p>
            <p className="text-[11px] text-neutral-500">pool {fmtXno(token.poolXno)} XNO · treasury {fmtTok(token.treasury, token.decimals)}</p>
          </div>
          {BigInt(token.poolXno) <= 0n && (
            <p className="text-[11px] text-white">
              {token.direct
                ? "Set the starting price to make it tradeable — the XNO figure is virtual (nothing is deposited)."
                : "This token has no pool yet — seed it to make it tradeable."}
            </p>
          )}
          {token.direct && (
            <p className="text-[11px] text-neutral-500">
              Zero-custody coin: the XNO reserve is a price-curve setting, not a deposit.
              No money leaves your wallet.
            </p>
          )}
          <div className="flex gap-2">
            <input className={inputC} placeholder={token.direct ? "virtual XNO reserve" : "XNO to add"} inputMode="decimal" value={seedXno} onChange={(e) => { setSeedTouched(true); setSeedXno(e.target.value); }} />
            <input className={inputC} placeholder="tokens to add" inputMode="decimal" value={seedTokens} onChange={(e) => { setSeedTouched(true); setSeedTokens(e.target.value); }} />
          </div>
          {BigInt(token.poolXno || "0") <= 0n && toRaw(seedXno, 30) > 0n && toRaw(seedTokens, token.decimals) > 0n && (() => {
            const px = priceOfSeed(toRaw(seedXno, 30), toRaw(seedTokens, token.decimals), token.decimals);
            const mc = (px * BigInt(token.supply)) / 10n ** BigInt(token.decimals);
            return <p className="text-[11px] text-neutral-500">recommended · starting price ≈ {fmtXno(px.toString())} XNO · starting market cap ≈ {fmtXno(mc.toString())} XNO <span className="text-neutral-600">(edit above to change)</span></p>;
          })()}
          <button className={btn} disabled={busy} onClick={seed}>{token.direct ? "Set starting price" : "Seed pool"}</button>
        </div>
      )}

      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-5 space-y-2">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Send tokens</p>
        <input className={inputC} placeholder="nano_… recipient" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
        <div className="flex gap-2">
          <input className={inputC} placeholder="amount" inputMode="decimal" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
          <button className="rounded-none bg-neutral-900 px-4 py-3 text-sm font-bold hover:bg-neutral-800 shrink-0 disabled:opacity-40" disabled={busy} onClick={transfer}>
            Send
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TradesPanel trades={token.trades} decimals={token.decimals} usd={usd} />
        <HoldersPanel holders={token.topHolders} creator={token.creator} decimals={token.decimals} />
      </div>

      {/* Mobile: conversion never scrolls away — fixed bar above the tab nav. */}
      <div className="sm:hidden fixed bottom-14 inset-x-0 z-30 border-t border-neutral-800 bg-black/95 backdrop-blur px-4 py-2 flex gap-2">
        <button className="flex-1 rounded-none bg-white py-3 text-sm font-black uppercase text-black" onClick={() => goTrade("buy")}>Buy</button>
        <button className="flex-1 rounded-none border border-white py-3 text-sm font-black uppercase text-white" onClick={() => goTrade("sell")}>Sell</button>
      </div>
    </div>
  );
}

/** Only allow http(s)/ipfs URLs in href/src sinks — blocks javascript:/data: XSS. */
function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ipfs:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function SocialLink({ href, label }: { href: string; label: string }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noreferrer" className="text-[11px] text-white hover:underline">
      {label}
    </a>
  );
}

function ProgressBar({ token }: { token: Token }) {
  // Honest "bonding" metric: how much of the creator's treasury has been seeded
  // into the AMM pool. initialTreasury = supply - creatorShare (the 95%).
  const initialTreasury = BigInt(token.supply) - BigInt(token.creatorShare);
  const treasury = BigInt(token.treasury);
  const graduated = initialTreasury > 0n && treasury === 0n;
  const pct = initialTreasury > 0n ? Number(((initialTreasury - treasury) * 100n) / initialTreasury) : 100;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[11px] text-neutral-500 mb-1">
        <span>{graduated ? "fully seeded · liquidity in pool" : "seeding liquidity"}</span>
        <span>{graduated ? "100%" : `${pct.toFixed(2)}%`}</span>
      </div>
      <div className="h-2 rounded-full bg-neutral-900 overflow-hidden">
        <div className="h-full bg-white" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function TradePanel({
  token,
  myHolding,
  xnoBal,
  amount,
  setAmount,
  slippage,
  setSlippage,
  busy,
  buy,
  sell,
  sendOp,
  address,
  promptUnlock,
  side,
  setSide,
}: {
  token: Token;
  myHolding: Holder | undefined;
  xnoBal: string;
  amount: string;
  setAmount: (s: string) => void;
  slippage: string;
  setSlippage: (s: string) => void;
  busy: boolean;
  buy: () => Promise<void>;
  sell: () => Promise<void>;
  sendOp: (tokenId: string, op: Op, label: string) => Promise<void>;
  address: string | null;
  promptUnlock: () => void;
  side: "buy" | "sell";
  setSide: (s: "buy" | "sell") => void;
}) {
  const slip = clampSlippage(slippage);
  // Is a wallet stored on this device (but locked)? Distinguishes "unlock" from
  // "create" so a locked user isn't told they're new.
  const [walletExists, setWalletExists] = useState(false);
  useEffect(() => { try { setWalletExists(!!loadWallet()); } catch {} }, [address]);

  // Live quote preview — mirrors the on-chain constant-product math exactly
  // (buy: 1% swap fee via quoteBuy; sell: no fee). Recomputed as the user types.
  const quote = useMemo(() => {
    const px = BigInt(token.poolXno);
    const pt = BigInt(token.poolTokens);
    if (px <= 0n || pt <= 0n) return null;
    const n = Number(amount || "0");
    if (!Number.isFinite(n) || n <= 0) return null;
    if (side === "buy") {
      const raw = BigInt(Math.floor(n * 1e30));
      if (raw <= 0n) return null;
      const out = quoteBuy(token.poolXno, token.poolTokens, raw);
      if (out <= 0n) return null;
      const ideal = (raw * pt) / px; // output with zero price impact
      const impact = ideal > 0n ? Math.max(0, Number((ideal - out) * 10000n / ideal) / 100) : 0;
      const min = (out * BigInt(Math.round((100 - slip) * 100))) / 10000n;
      return { outStr: fmtTok(out.toString(), token.decimals), unit: tokSym(token), minStr: fmtTok(min.toString(), token.decimals), impact };
    }
    const raw = BigInt(Math.floor(n * 10 ** token.decimals));
    if (raw <= 0n) return null;
    const out = quoteSell(token.poolXno, token.poolTokens, raw);
    if (out <= 0n) return null;
    const ideal = (raw * px) / pt;
    const impact = ideal > 0n ? Math.max(0, Number((ideal - out) * 10000n / ideal) / 100) : 0;
    const min = (out * BigInt(Math.round((100 - slip) * 100))) / 10000n;
    return { outStr: fmtXno(out.toString()), unit: "XNO", minStr: fmtXno(min.toString()), impact };
  }, [amount, side, slip, token.poolXno, token.poolTokens, token.decimals, token.symbol]);

  return (
    <div className="space-y-3">
      {/* Fast onboarding: a newcomer arriving on a shared coin link gets the
          shortest possible path — create a wallet in place (UnlockModal),
          then fund it by scanning/tapping straight from their existing XNO
          wallet. Incoming funds auto-receive every few seconds; there is no
          manual receive step and no navigation away from the coin. */}
      {/* Locked / no wallet: never show a confusing 0 balance — prompt to unlock
          (existing wallet) or set one up (new user). Clicking Buy/Sell also
          opens this, but showing it up front avoids the "why is my balance 0"
          confusion for someone who's just locked. */}
      {!address && (
        walletExists ? (
          <button
            className="w-full rounded-none border border-white bg-neutral-950 p-3 text-left hover:bg-neutral-900"
            onClick={promptUnlock}
          >
            <span className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide"><LockIcon /> Unlock your wallet to trade</span>
            <span className="mt-1 block text-[11px] text-neutral-500">Your balance and holdings are hidden until you unlock.</span>
          </button>
        ) : (
          <button
            className="w-full rounded-none border border-neutral-700 bg-neutral-950 p-3 text-left hover:border-white"
            onClick={promptUnlock}
          >
            <span className="block text-xs font-black uppercase tracking-wide">New here? Start in 30 seconds</span>
            <span className="mt-1 block text-[11px] text-neutral-500">
              1. Create a wallet (right here, stays in your browser) · 2. Send it XNO from any wallet · 3. Buy.
            </span>
          </button>
        )
      )}
      {address && BigInt(xnoBal || "0") <= 0n && (
        <div className="rounded-none border border-neutral-700 bg-neutral-950 p-3">
          <p className="text-xs font-black uppercase tracking-wide">Fund your wallet to buy</p>
          <div className="mt-2 flex items-start gap-3">
            <div className="shrink-0 bg-white p-1.5">
              <QRCodeSVG value={`nano:${address}`} size={96} bgColor="#ffffff" fgColor="#000000" level="M" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <p className="text-[11px] text-neutral-400 leading-relaxed">
                Scan with any XNO wallet, or send to this address. Nano is feeless and lands in seconds.
              </p>
              <button
                className="max-w-full truncate rounded-none bg-neutral-900 px-2 py-1 text-[11px] font-mono text-neutral-200 hover:bg-neutral-800"
                title={`${address} — click to copy`}
                onClick={() => { try { navigator.clipboard.writeText(address); } catch {} }}
              >
                {short(address)} ⧉ copy
              </button>
              <a className="block text-[11px] font-bold text-white underline" href={`nano:${address}`}>
                Open in your XNO wallet →
              </a>
              <p className="text-[10px] text-neutral-600">waiting for XNO… this page updates by itself the moment it arrives</p>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span className="flex items-center gap-1">balance: {!address ? <><LockIcon /> unlock to view</> : side === "buy" ? `${fmtXno(xnoBal)} XNO` : `${fmtTok(token.myBalance, token.decimals)} ${tokSym(token)}`}</span>
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-500">slippage %</span>
          <input
            className="w-14 rounded-none bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs text-white text-right"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
        </label>
      </div>
      {slip > 0 && <p className="text-[10px] text-neutral-500">if the price moves more than {slip}% against you, the trade cancels instead of filling worse</p>}
      <div className="grid grid-cols-2 gap-2">
        <button
          className={"rounded-none py-2 text-sm font-bold " + (side === "buy" ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
          onClick={() => setSide("buy")}
        >
          Buy
        </button>
        <button
          className={"rounded-none py-2 text-sm font-bold " + (side === "sell" ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
          onClick={() => setSide("sell")}
        >
          Sell
        </button>
      </div>
      <div className="flex gap-2">
        <input
          className={inputC}
          placeholder={side === "buy" ? "XNO amount" : "token amount"}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {side === "buy" && (
          <button
            className="shrink-0 rounded-none bg-neutral-900 px-3 text-xs font-bold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            disabled={BigInt(xnoBal) <= 0n}
            onClick={() => { const usable = BigInt(xnoBal) - 10n ** 24n; setAmount(usable > 0n ? fmtXnoPlain(usable.toString()) : "0"); }}
          >
            Max
          </button>
        )}
        {side === "sell" && (
          <button
            className="shrink-0 rounded-none bg-neutral-900 px-3 text-xs font-bold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            disabled={BigInt(token.myBalance || "0") <= 0n}
            onClick={() => setAmount(fmtTok(token.myBalance, token.decimals))}
          >
            Max
          </button>
        )}
      </div>
      {side === "buy" && (
        <div className="grid grid-cols-4 gap-2">
          {["0.1", "0.5", "1", "5"].map((v) => {
            const over = toRaw(v, 30) > BigInt(xnoBal || "0"); // more than you hold
            return (
              <button
                key={v}
                disabled={over}
                title={over ? "more than your balance" : undefined}
                className="rounded-none border border-neutral-800 py-1.5 text-xs font-bold text-neutral-400 hover:border-white hover:text-white disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
                onClick={() => setAmount(v)}
              >
                {v} XNO
              </button>
            );
          })}
        </div>
      )}
      {/* Sell quick-fills: % of YOUR balance (token.myBalance is authoritative —
          the top-holders list is capped, so never gate on it). One tap to sell
          part or all of your bag when you don't know the exact amount. */}
      {side === "sell" && (
        <>
          <div className="flex items-center justify-between text-[11px] text-neutral-500">
            <span>{address ? `your ${tokSym(token)}` : "sell"}</span>
            <span className="tabular-nums text-neutral-300">
              {!address ? "unlock wallet to sell" : <>{fmtTok(token.myBalance, token.decimals)} {tokSym(token)}</>}
            </span>
          </div>
          {/* Staked tokens aren't sellable until unstaked — say so instead of a
              bare "0" when the balance is all staked, so a holder isn't confused. */}
          {address && BigInt(token.myBalance || "0") <= 0n && BigInt(token.myStaked || "0") > 0n && (
            <p className="text-[11px] text-neutral-500">
              You have {fmtTok(token.myStaked, token.decimals)} {tokSym(token)} <span className="text-neutral-400">staked</span> — unstake it first to sell (staking earns rewards; a 20% exit tax applies).
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            {[10, 25, 50, 100].map((p) => {
              const bal = BigInt(token.myBalance || "0");
              const amt = (bal * BigInt(p)) / 100n;
              return (
                <button
                  key={p}
                  disabled={bal <= 0n}
                  title={bal <= 0n ? `you hold no ${tokSym(token)}` : `${p}% of your ${tokSym(token)}`}
                  className="rounded-none border border-neutral-800 py-1.5 text-xs font-bold text-neutral-400 hover:border-white hover:text-white disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-300"
                  onClick={() => setAmount(fmtTok(amt.toString(), token.decimals))}
                >
                  {p === 100 ? "MAX" : `${p}%`}
                </button>
              );
            })}
          </div>
        </>
      )}
      {quote && (
        <div className="rounded-none border border-neutral-800 bg-neutral-950 p-3 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-neutral-500">you receive ≈</span>
            <span className="font-bold text-white">{quote.outStr} {quote.unit}</span>
          </div>
          {slip > 0 && (
            <div className="flex justify-between">
              <span className="text-neutral-500">minimum received</span>
              <span className="text-neutral-300">{quote.minStr} {quote.unit}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-neutral-500">price impact</span>
            <span className={quote.impact >= 5 ? "text-red-500" : quote.impact >= 1 ? "text-amber-500" : "text-neutral-300"}>
              {quote.impact.toFixed(2)}%
            </span>
          </div>
        </div>
      )}
      {token.direct && side === "sell" && (() => {
        const raw = toRaw(amount, token.decimals);
        if (raw <= 0n) return null;
        const p = previewSellDirect(token, raw, xnoBal);
        return (
          <div className="rounded-none border border-neutral-800 bg-neutral-950 p-2.5 text-[11px] text-neutral-500 space-y-1">
            <div className="flex justify-between">
              <span>yours instantly (collateral released)</span>
              <span className="tabular-nums text-white">{fmtXno(p.instant.toString())} XNO</span>
            </div>
            {p.queued > 0n && (
              <div className="flex justify-between">
                <span>profit, queued — next buys pay your wallet</span>
                <span className="tabular-nums text-white">{fmtXno(p.queued.toString())} XNO</span>
              </div>
            )}
          </div>
        );
      })()}
      {token.direct && side === "buy" && token.queueHead && (
        <p className="text-[11px] text-neutral-500">
          your XNO goes straight to the seller ahead in line — wallet to wallet, up to{" "}
          <span className="tabular-nums text-neutral-300">{fmtXno(token.queueHead.owedRaw)} XNO</span>
        </p>
      )}
      <button className={btn} disabled={busy} onClick={side === "buy" ? buy : sell}>
        {busy ? "…" : side === "buy" ? (token.direct && !token.queueHead ? "Buy (XNO stays in your wallet)" : "Buy (send XNO)") : "Sell tokens"}
      </button>

      <StakeBox token={token} busy={busy} sendOp={sendOp} />

      {/* Direct-Settlement surfaces: queued payout position + collateral. */}
      {token.direct && BigInt(token.myQueueOwed || "0") > 0n && (
        <div className="rounded-none border border-neutral-700 bg-neutral-950 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">In line for payout</p>
          <p className="mt-0.5 text-sm font-black tabular-nums">{fmtXno(token.myQueueOwed)} XNO</p>
          <p className="mt-1 text-[11px] text-neutral-500 leading-relaxed">
            The next buys pay this straight to your wallet, first come first served — no
            withdraw step, no one to ask. {token.coveragePct != null && <>Coverage now: {token.coveragePct.toFixed(0)}%.</>}
          </p>
        </div>
      )}
      {token.direct && BigInt(token.myEarmark || "0") > 0n && (
        <div className="rounded-none border border-neutral-800 bg-neutral-950 p-3">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Your collateral</p>
          <p className="mt-0.5 text-sm font-black tabular-nums">{fmtXno(token.myEarmark)} XNO <span className="text-[10px] font-normal text-neutral-500">— still in YOUR wallet</span></p>
          <p className="mt-1 text-[11px] text-neutral-500 leading-relaxed">
            It backs your position and is released the moment you sell. Keep at least{" "}
            <span className="tabular-nums text-neutral-300">{fmtXno(token.myFloor)} XNO</span> in this wallet —
            spending below that line shrinks your position to match.
          </p>
        </div>
      )}

      {/* Exit-only settlement (pooled tokens): sell proceeds accrue here
          instantly (zero waiting, zero PoW); one Withdraw click settles real
          XNO on-chain. Direct tokens never show this — they settle at sell. */}
      {!token.direct && BigInt(token.myCredit || "0") > 0n && (
        <div className="rounded-none border border-neutral-700 bg-neutral-950 p-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Game balance</p>
            <p className="text-sm font-black tabular-nums">{fmtXno(token.myCredit)} XNO <span className="text-[10px] font-normal text-neutral-500">from your sells — yours to withdraw</span></p>
          </div>
          <button
            className="shrink-0 rounded-none bg-white px-4 py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200 disabled:opacity-40"
            disabled={busy}
            onClick={() => sendOp(token.tokenId, { kind: "withdraw" }, "withdraw")}
          >
            Withdraw
          </button>
        </div>
      )}

      {token.direct && (
        <p className="text-[11px] text-neutral-500">
          zero-custody coin — no pool account exists. Trades settle wallet-to-wallet;
          nobody (including this site) can touch traders' money.
        </p>
      )}
      {token.pool && (
        <p className="text-[11px] text-neutral-500">
          liquidity pool account{" "}
          <button
            className="font-mono hover:text-neutral-300"
            title={`${token.pool} — click to copy`}
            onClick={() => { try { navigator.clipboard.writeText(token.pool!); } catch {} }}
          >
            {short(token.pool)} ⧉
          </button>
        </p>
      )}
    </div>
  );
}

// Staking: real amount inputs (no more hardcoded amounts) plus a live readout
// Elegant black/white confirm dialog for the taxed staking actions. Staking is
// free but LOCKS value behind a 20% exit tax, so both actions get an explicit,
// on-theme heads-up before anything is signed.
function StakeConfirm({
  kind,
  amount,
  decimals,
  symbol,
  onConfirm,
  onCancel,
}: {
  kind: "stake" | "unstake";
  amount: bigint;
  decimals: number;
  symbol: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const pct = (n: bigint) => (amount * n) / 100n;
  const back = pct(80n); // received on unstake
  const burn = pct(5n); // permanent deflation
  const rebate = pct(15n); // to remaining stakers
  const isUnstake = kind === "unstake";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-none border border-neutral-700 bg-neutral-950 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <LockIcon size={14} />
          <h3 className="text-sm font-black uppercase tracking-wide text-white">
            {isUnstake ? "Unstake — 20% exit tax" : "Staking locks a 20% exit tax"}
          </h3>
        </div>

        {isUnstake ? (
          <div className="space-y-2 text-[13px] text-neutral-300">
            <p>Unstaking is taxed <span className="text-white font-black">20%</span>. On {fmtTok(amount.toString(), decimals)} {symbol}:</p>
            <div className="rounded-none border border-neutral-800 divide-y divide-neutral-800 text-xs">
              <Line k="you receive" v={`${fmtTok(back.toString(), decimals)} ${symbol}`} strong />
              <Line k="burned forever (5%)" v={`${fmtTok(burn.toString(), decimals)} ${symbol}`} />
              <Line k="paid to other stakers (15%)" v={`${fmtTok(rebate.toString(), decimals)} ${symbol}`} />
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-[13px] text-neutral-300">
            <p>Staking itself is <span className="text-white font-black">free</span> and earns you XNO rebates.</p>
            <p>But be aware: <span className="text-white font-black">unstaking later is taxed 20%</span> (5% burned, 15% shared to other stakers) — so you'd get back <span className="text-white font-black">{fmtTok(back.toString(), decimals)} {symbol}</span> of the {fmtTok(amount.toString(), decimals)} {symbol} you stake. Stake to hold.</p>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 rounded-none border border-neutral-700 py-2 text-xs font-black uppercase tracking-wide text-neutral-300 hover:border-white hover:text-white">
            Cancel
          </button>
          <button onClick={onConfirm} className="flex-1 rounded-none bg-white py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200">
            {isUnstake ? "Unstake anyway" : "Stake"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Line({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-neutral-500">{k}</span>
      <span className={"tabular-nums " + (strong ? "text-white font-black" : "text-neutral-300")}>{v}</span>
    </div>
  );
}

// Paper-Hands Receipt — fires the moment someone sells or unstakes. A stark
// thermal-receipt card citing the EXACT cost of folding (the 20% unstake tax
// split, or the XNO taken for a sell), with a self-deprecating share + a
// "buy back in" redemption CTA. Shame + redemption, both shareable.
function PaperHandsReceipt({
  kind,
  symbol,
  decimals,
  tokenId,
  tokens,
  xnoOut,
  onRedeem,
  onClose,
}: {
  kind: "sell" | "unstake";
  symbol: string;
  decimals: number;
  tokenId: string;
  tokens: bigint;
  xnoOut?: bigint;
  onRedeem: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const pct = (n: bigint) => (tokens * n) / 100n;
  const url = `${typeof window !== "undefined" ? window.location.origin : "https://www.hodlgame.fun"}/t/${tokenId}`;
  const line = kind === "unstake"
    ? `I paper-handed and ate the 20% unstake tax on $${symbol} 📄🖐️ Receipt attached. ${url}`
    : `I folded my $${symbol} bag 📄🖐️ Somebody screenshot this so I never do it again. ${url}`;
  const share = async () => {
    try {
      if (typeof navigator !== "undefined" && (navigator as any).share) {
        await (navigator as any).share({ title: "Paper-hands receipt", text: line, url });
        return;
      }
    } catch { return; }
    try { await navigator.clipboard.writeText(line); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
      <div className="w-full max-w-xs rounded-none border border-neutral-700 bg-neutral-950 p-5 space-y-3 font-mono" onClick={(e) => e.stopPropagation()}>
        <div className="text-center border-b border-dashed border-neutral-700 pb-2">
          <p className="text-sm font-black tracking-[0.2em] text-white">PAPER-HANDS RECEIPT</p>
          <p className="text-[10px] text-neutral-500">{kind === "unstake" ? "UNSTAKE" : "SELL"} · ${symbol.toUpperCase()}</p>
        </div>
        <div className="text-xs divide-y divide-neutral-800 border border-neutral-800">
          {kind === "unstake" ? (
            <>
              <Line k="unstaked" v={`${fmtTok(tokens.toString(), decimals)} ${symbol}`} />
              <Line k="you kept (80%)" v={`${fmtTok(pct(80n).toString(), decimals)} ${symbol}`} strong />
              <Line k="burned forever (5%)" v={`−${fmtTok(pct(5n).toString(), decimals)}`} />
              <Line k="paid to hodlers (15%)" v={`−${fmtTok(pct(15n).toString(), decimals)}`} />
            </>
          ) : (
            <>
              <Line k="sold" v={`${fmtTok(tokens.toString(), decimals)} ${symbol}`} />
              <Line k="you got" v={xnoOut != null ? `${fmtXno(xnoOut.toString())} XNO` : "—"} strong />
              <Line k="diamond hands" v="0.00 💎" />
            </>
          )}
        </div>
        <p className="text-center text-[10px] text-neutral-600">— thanks for playing, paperhand —</p>
        <div className="flex flex-col gap-2">
          <button onClick={onRedeem} className="w-full rounded-none bg-white py-2 text-[11px] font-black uppercase tracking-wide text-black hover:bg-neutral-200">
            Redeem yourself — buy back in
          </button>
          <button onClick={share} className="w-full rounded-none border border-neutral-700 py-2 text-[11px] font-black uppercase tracking-wide text-neutral-300 hover:border-white hover:text-white">
            {copied ? "copied" : "Cope — share the receipt"}
          </button>
        </div>
      </div>
    </div>
  );
}

// of the connected account's staked balance and claimable XNO rebate rewards.
function StakeBox({
  token,
  busy,
  sendOp,
}: {
  token: Token;
  busy: boolean;
  sendOp: (tokenId: string, op: Op, label: string) => Promise<void>;
}) {
  const [stakeAmt, setStakeAmt] = useState("");
  const [unstakeAmt, setUnstakeAmt] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "stake" | "unstake"; raw: bigint } | null>(null);
  const [receipt, setReceipt] = useState<bigint | null>(null); // unstake amount → paper-hands receipt
  const staked = BigInt(token.myStaked || "0");
  const claimable = BigInt(token.myClaimable || "0");
  const bal = BigInt(token.myBalance || "0");

  // Both actions open the tax-warning dialog first; nothing is signed until the
  // user confirms in it.
  const doStake = () => {
    const raw = toRaw(stakeAmt, token.decimals);
    if (raw <= 0n) return;
    setConfirm({ kind: "stake", raw });
  };
  const doUnstake = () => {
    const raw = toRaw(unstakeAmt, token.decimals);
    if (raw <= 0n) return;
    setConfirm({ kind: "unstake", raw });
  };
  const runConfirmed = () => {
    if (!confirm) return;
    const { kind, raw } = confirm;
    setConfirm(null);
    sendOp(token.tokenId, { kind, amount: raw }, kind).then(() => {
      if (kind === "stake") setStakeAmt("");
      else { setUnstakeAmt(""); setReceipt(raw); } // fire the paper-hands receipt on unstake
    });
  };

  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-3 space-y-3">
      {confirm && (
        <StakeConfirm
          kind={confirm.kind}
          amount={confirm.raw}
          decimals={token.decimals}
          symbol={tokSym(token)}
          onConfirm={runConfirmed}
          onCancel={() => setConfirm(null)}
        />
      )}
      {receipt != null && (
        <PaperHandsReceipt
          kind="unstake"
          symbol={tokSym(token)}
          decimals={token.decimals}
          tokenId={token.tokenId}
          tokens={receipt}
          onRedeem={() => setReceipt(null)}
          onClose={() => setReceipt(null)}
        />
      )}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-neutral-400 font-bold">Stake · earn XNO rebates</span>
        <span className="text-neutral-500">staked {fmtTok(token.myStaked, token.decimals)} {tokSym(token)}</span>
      </div>

      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <input
            className={inputC}
            placeholder="stake amount"
            inputMode="decimal"
            value={stakeAmt}
            onChange={(e) => setStakeAmt(e.target.value)}
          />
          {bal > 0n && (
            <div className="grid grid-cols-3 gap-1">
              {[25, 50, 100].map((p) => (
                <button key={p}
                  className="rounded-none border border-neutral-800 py-1 text-[10px] font-bold text-neutral-400 hover:border-white hover:text-white"
                  onClick={() => setStakeAmt(fmtTok(((bal * BigInt(p)) / 100n).toString(), token.decimals))}>
                  {p === 100 ? "MAX" : `${p}%`}
                </button>
              ))}
            </div>
          )}
        </div>
        <ActionBtn disabled={busy || bal <= 0n} onClick={doStake}>Stake</ActionBtn>
      </div>

      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <input
            className={inputC}
            placeholder="unstake amount"
            inputMode="decimal"
            value={unstakeAmt}
            onChange={(e) => setUnstakeAmt(e.target.value)}
          />
          {staked > 0n && (
            <div className="grid grid-cols-3 gap-1">
              {[25, 50, 100].map((p) => (
                <button key={p}
                  className="rounded-none border border-neutral-800 py-1 text-[10px] font-bold text-neutral-400 hover:border-white hover:text-white"
                  onClick={() => setUnstakeAmt(fmtTok(((staked * BigInt(p)) / 100n).toString(), token.decimals))}>
                  {p === 100 ? "MAX" : `${p}%`}
                </button>
              ))}
            </div>
          )}
        </div>
        <ActionBtn disabled={busy || staked <= 0n} onClick={doUnstake}>Unstake</ActionBtn>
      </div>
      {unstakeAmt && Number(unstakeAmt) > 0 && (
        <p className="text-[10px] text-white">20% exit tax on unstake (5% burned, 15% to stakers)</p>
      )}

      <div className="flex items-center justify-between border-t border-neutral-800 pt-2">
        <span className="text-[11px] text-neutral-500">claimable ≈ <span className="text-white font-bold">{fmtXno(token.myClaimable)} XNO</span></span>
        <button
          className="rounded-none bg-neutral-900 border border-neutral-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-neutral-800 disabled:opacity-40"
          disabled={busy || claimable <= 0n}
          onClick={() => sendOp(token.tokenId, { kind: "claim" }, "claim")}
        >
          Claim
        </button>
      </div>
    </div>
  );
}

function ActionBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) {
  return (
    <button className="rounded-none border border-neutral-800 py-3 text-sm font-bold text-neutral-200 hover:border-white disabled:opacity-40" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function TradesPanel({ trades, decimals, usd }: { trades: Trade[]; decimals: number; usd: number | null }) {
  // XNO value of a trade = token amount × price-per-whole-token.
  const tradeXno = (t: Trade) => ((BigInt(t.amountRaw) * BigInt(t.priceRaw)) / 10n ** BigInt(decimals)).toString();
  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400 mb-2">Recent trades</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {trades.length === 0 && <p className="text-xs text-neutral-500">no trades yet</p>}
        {trades.map((t, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-neutral-500 font-mono shrink-0">{short(t.account)}</span>
            <span className={"shrink-0 " + (t.kind === "buy" ? "text-green-500" : "text-red-500")}>
              {t.kind === "buy" ? "▲" : "▼"} {t.kind}
            </span>
            <span className="text-neutral-400 truncate">
              {fmtXno(tradeXno(t))} XNO{usd != null && <span className="text-neutral-500"> ({fmtUsd(tradeXno(t), usd)})</span>}
            </span>
            <span className="text-neutral-500 shrink-0">{timeAgo(t.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldersPanel({ holders, creator, decimals }: { holders: Holder[]; creator: string; decimals: number }) {
  const top = holders.slice(0, 20);
  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400 mb-2">Top holders</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {top.map((h, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 font-mono flex items-center gap-1">
              {i + 1}. {short(h.account)} {h.account === creator && <span className="text-white">dev</span>}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-neutral-400">{fmtTok(h.balanceRaw, decimals)}</span>
              <span className="text-neutral-500 w-12 text-right">{h.pct.toFixed(2)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentThread({ tokenId, comments, keys, isDev }: { tokenId: string; comments: Comment[]; keys: Keys | null; isDev: boolean }) {
  const [text, setText] = useState("");
  const [local, setLocal] = useState<Comment[]>([]);

  async function post() {
    const clean = text.trim().slice(0, 280);
    if (!keys || !clean) return;
    // Sign the exact text + timestamp: authorship is cryptographic.
    const time = Date.now();
    const digest = commentSignDigest(tokenId, time, clean);
    const signature = nanocurrency.signBlock({ hash: digest, secretKey: keys.secretKey });
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, account: keys.address, text: clean, time, signature }),
    });
    const j = await res.json();
    if (j.comment) setLocal((l) => [...l, j.comment]);
    setText("");
  }

  const all = [...local, ...comments];
  return (
    <div className="space-y-3">
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {all.length === 0 && <p className="text-xs text-neutral-500">be the first to comment</p>}
        {all.map((c) => (
          <div key={c.id} className="rounded-none bg-neutral-950 p-2.5">
            <p className="text-[11px] text-neutral-500 font-mono">{short(c.account)} · {timeAgo(c.time)}</p>
            <p className="text-xs text-neutral-300 mt-1">{c.text}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={inputC} placeholder="say something…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="shrink-0 rounded-none bg-neutral-900 px-4 py-3 text-sm font-bold hover:bg-neutral-800" onClick={post}>
          Post
        </button>
      </div>
    </div>
  );
}

// Creator-only: (re)publish a coin's off-chain metadata for an existing token —
// so a coin whose name/image failed to save at launch (or needs updating) can be
// fixed without re-launching. Same signed-update path as CreateToken.
function EditCoinInfo({ token, keys, say }: { token: Token; keys: Keys; say: (s: string) => void }) {
  const [open, setOpen] = useState(!token.name && !token.symbol); // auto-open if unnamed
  const [name, setName] = useState(token.name);
  const [symbol, setSymbol] = useState(token.symbol);
  const [image, setImage] = useState(token.image);
  const [description, setDescription] = useState(token.description);
  const [website, setWebsite] = useState(token.website);
  const [twitter, setTwitter] = useState(token.twitter);
  const [telegram, setTelegram] = useState(token.telegram);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (!file.type.startsWith("image/")) return say("please choose an image file");
    setUploading(true);
    try {
      let body: Blob = file;
      try { body = (await resizeImageFile(file, 512)).blob; } catch {}
      const fd = new FormData();
      fd.append("file", body, "image.png");
      const j = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
      if (j.url) setImage(j.url); else say("upload failed: " + (j.error ?? "unknown"));
    } catch (e: any) { say("upload failed: " + e.message); }
    finally { setUploading(false); }
  }

  async function save() {
    const meta = sanitizeMeta({ name, symbol, decimals: token.decimals, image, description, website, twitter, telegram });
    if (!meta.name || !meta.symbol || !meta.image) return say("name, symbol, and image are required");
    setBusy(true);
    try {
      const seq = Date.now();
      const digest = metaSignDigest(token.tokenId, seq, "update", metaFieldsHash(meta));
      const signature = nanocurrency.signBlock({ hash: digest, secretKey: keys.secretKey });
      const r = await fetch("/api/tokens", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId: token.tokenId, ...meta, account: keys.address, signature, seq, action: "update" }),
      });
      if (r.ok) { say("coin info saved ✓"); setOpen(false); }
      else { const e = await r.json().catch(() => ({})); say("save failed: " + (e.error ?? r.status)); }
    } catch (e: any) { say("save failed: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-none border border-neutral-600 bg-neutral-950 p-5 space-y-2">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-bold text-white">Coin info <span className="text-[11px] font-normal text-neutral-500">creator</span></span>
        <span className="text-neutral-500 text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {!token.name && !token.symbol && <p className="text-[11px] text-white">This coin has no name yet — set it here so it shows everywhere.</p>}
      {open && (
        <>
          <div className="flex items-center gap-3">
            <Avatar image={image} symbol={symbol || token.tokenId.slice(0, 2)} size={44} />
            <label className="text-xs text-white cursor-pointer">
              {uploading ? "uploading…" : "upload image"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
          </div>
          <input className={inputC} placeholder="image URL (optional)" value={image} onChange={(e) => setImage(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className={inputC} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className={inputC} placeholder="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
          <textarea className={inputC} placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          <input className={inputC} placeholder="website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <input className={inputC} placeholder="https://x.com/… (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
          <input className={inputC} placeholder="https://t.me/… (optional)" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
          <button className={btn} disabled={busy} onClick={save}>{busy ? "saving…" : "Save coin info"}</button>
        </>
      )}
    </div>
  );
}

// Launch Certificate — the celebratory "your coin is live" moment shown the
// instant a launch confirms. Captures peak creator energy and hands them a
// one-tap share so they recruit their own first holders (they own 5%, so they
// want to). Monochrome, on-brand, with the /t/<id> unfurl link baked in.
function LaunchCertificate({
  info,
  onView,
  onClose,
}: {
  info: { tokenId: string; name: string; symbol: string; image: string };
  onView: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = `${typeof window !== "undefined" ? window.location.origin : "https://www.hodlgame.fun"}/t/${info.tokenId}`;
  const text = `I just launched $${info.symbol} on HodlGame — feeless, zero-custody, creator capped at 5%. First holders win. ${url}`;
  const share = async () => {
    try {
      if (typeof navigator !== "undefined" && (navigator as any).share) {
        await (navigator as any).share({ title: `${info.name} ($${info.symbol}) is live`, text, url });
        return;
      }
    } catch { return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-none border border-neutral-700 bg-black p-6 space-y-4 text-center" onClick={(e) => e.stopPropagation()}>
        <p className="text-[11px] font-black uppercase tracking-[0.25em] text-neutral-500">Certificate of Launch</p>
        <div className="flex justify-center">
          <div className="border border-neutral-700 p-1"><Avatar image={info.image} symbol={info.symbol} size={96} /></div>
        </div>
        <div>
          <h3 className="text-2xl font-black text-white leading-tight">{info.name}</h3>
          <p className="text-sm text-neutral-400 tracking-wide">${info.symbol.toUpperCase()}</p>
        </div>
        <p className="text-[12px] text-neutral-400">Live on Nano · feeless · zero-custody · you keep 5%. It's worthless until people hold it — go get your first holders.</p>
        <div className="flex flex-col gap-2 pt-1">
          <button onClick={share} className="w-full rounded-none bg-white py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200">
            {copied ? "copied — paste it anywhere" : "Recruit your first holders →"}
          </button>
          <button onClick={onView} className="w-full rounded-none border border-neutral-700 py-2.5 text-xs font-black uppercase tracking-wide text-neutral-200 hover:border-white hover:text-white">
            View / trade your coin
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateToken({
  busy,
  setBusy,
  say,
  keys,
  submitBlock,
  promptUnlock,
  onCreated,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  say: (s: string) => void;
  keys: Keys | null;
  submitBlock: (link: string, delta: bigint) => Promise<string>;
  promptUnlock: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [image, setImage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showReq, setShowReq] = useState(false); // flag the required name/symbol fields on a failed submit
  // Monochrome Maker: default every uploaded coin image to the B/W brand look so
  // the whole feed + all share cards read as one family. Toggleable — we keep
  // the original file so flipping it re-processes without a re-upload.
  const [mono, setMono] = useState(true);
  const [origFile, setOrigFile] = useState<File | null>(null);
  // Launch Certificate: the celebratory "your coin is live" moment (rendered below).
  const [launched, setLaunched] = useState<{ tokenId: string; name: string; symbol: string; image: string } | null>(null);

  async function processAndUpload(file: File, useMono: boolean) {
    if (!file.type.startsWith("image/")) return say("please choose an image file");
    setUploading(true);
    try {
      // Downscale + normalize in the browser first; fall back to the raw file
      // only if canvas resizing isn't available.
      let body: Blob = file;
      try {
        body = (await resizeImageFile(file, 512)).blob;
      } catch {
        /* keep original; the server still validates it */
      }
      if (useMono) {
        try { body = await monochromeBlob(body); } catch { /* keep color if the filter fails */ }
      }
      const fd = new FormData();
      fd.append("file", body, "image.png");
      const j = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
      if (j.url) setImage(j.url);
      else say("upload failed: " + (j.error ?? "unknown"));
    } catch (e: any) {
      say("upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  const pickFile = (file: File) => { setOrigFile(file); void processAndUpload(file, mono); };
  const toggleMono = () => {
    const v = !mono;
    setMono(v);
    if (origFile) void processAndUpload(origFile, v);
  };

  async function launch() {
    if (!keys) return promptUnlock();
    const decimals = 6;
    // Exact BigInt math — `Number(supply) * 10**decimals` loses precision above
    // 2^53. `supply` is a digits-only string, so BigInt(supply) is exact.
    const whole = /^\d+$/.test(supply.trim()) ? BigInt(supply.trim()) : 0n;
    const rawSupply = whole * 10n ** BigInt(decimals);
    // Never launch on top of an in-flight image upload — wait for the stored
    // URL to land first, so the metadata we sign includes the saved image.
    if (uploading) return say("wait for the image to finish uploading");
    // Name, symbol AND image are REQUIRED. Validate the SANITIZED values (the
    // same ones the server verifies and stores) BEFORE any on-chain block, so the
    // form can never mint a nameless/imageless coin — a symbol of only invalid
    // chars, or an unsafe image URL, sanitizes to "" and is rejected here.
    const meta = sanitizeMeta({ name, symbol, decimals, image, description, website, twitter, telegram });
    if (!meta.name || !meta.symbol || !meta.image) {
      setShowReq(true);
      return say("name, symbol, and image are required");
    }
    setShowReq(false);
    if (rawSupply <= 0n) return say("enter supply");
    if (whole > 1_000_000_000_000_000n) return say("supply too large (max 1 quadrillion tokens)");
    setBusy(true);
    try {
      const hash = await submitBlock(
        encodeOpLink("", { kind: "launch", supply: rawSupply, name: meta.name, symbol: meta.symbol, decimals, image: "", direct: true }),
        1n
      );
      const tokenId = tokenIdFromLaunchHash(hash);
      // Sign the SANITIZED fields (the server verifies against its own
      // sanitized copy) with the launch key — only the creator can publish.
      const seq = Date.now();
      const digest = metaSignDigest(tokenId, seq, "update", metaFieldsHash(meta));
      const signature = nanocurrency.signBlock({ hash: digest, secretKey: keys.secretKey });
      const postMeta = () =>
        fetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId, ...meta, account: keys.address, signature, seq, action: "update" }),
        });
      // The launch is on-chain; the name/symbol/image are off-chain. Don't report
      // success unless BOTH land — a silent metadata failure leaves a nameless
      // coin. Retry once, then surface the error so it can be re-published.
      let mres = await postMeta();
      if (!mres.ok) mres = await postMeta();
      if (!mres.ok) {
        const err = await mres.json().catch(() => ({}));
        say(`launched on-chain, but name/image didn't save: ${err.error ?? mres.status}`);
      } else {
        say(`launch ✓ ${hash.slice(0, 10)}…`);
      }
      // Launch Certificate: capture the highest-energy moment and turn the
      // creator into their own first recruiter, before they navigate away.
      setLaunched({ tokenId, name: meta.name, symbol: meta.symbol, image: meta.image });
    } catch (e: any) {
      say("launch failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  // Live view of the required fields as the SERVER will store them, so the UI
  // flags exactly what the launch guard will reject.
  const reqMeta = sanitizeMeta({ name, symbol, decimals: 6, image, description, website, twitter, telegram });
  const missing = [
    !reqMeta.name && "name",
    !reqMeta.symbol && "symbol",
    !reqMeta.image && "image",
  ].filter(Boolean) as string[];

  return (
    <div className="rounded-none border border-neutral-800 bg-neutral-950 p-5 space-y-3">
      {launched && (
        <LaunchCertificate
          info={launched}
          onView={() => { const t = launched.tokenId; setLaunched(null); onCreated(t); }}
          onClose={() => setLaunched(null)}
        />
      )}
      <h3 className="font-black text-lg">Start a new coin</h3>
      <div className="flex items-center gap-3">
        <div className={"rounded-none " + (showReq && !reqMeta.image ? "ring-1 ring-red-500" : "")}>
          <Avatar image={image} symbol={symbol} size={56} />
        </div>
        <label className="text-xs text-white cursor-pointer">
          {uploading ? "uploading…" : "upload image *"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); setShowReq(false); }} />
        </label>
        <span className="text-[11px] text-neutral-500">or a URL below</span>
      </div>
      {/* Monochrome Maker toggle — on by default so every coin lands in the B/W
          house style; the creator can keep original colors if they prefer. */}
      {origFile && (
        <button type="button" onClick={toggleMono} disabled={uploading}
          className="flex items-center gap-2 text-[11px] text-neutral-400 hover:text-white disabled:opacity-50">
          <span className={"inline-flex h-4 w-7 items-center rounded-full border border-neutral-600 px-0.5 transition-colors " + (mono ? "bg-white justify-end" : "bg-neutral-900 justify-start")}>
            <span className={"h-3 w-3 rounded-full " + (mono ? "bg-black" : "bg-neutral-500")} />
          </span>
          Monochrome brand style {mono ? "on" : "off"}
        </button>
      )}
      <input
        className={inputC + (showReq && !reqMeta.image ? " ring-1 ring-red-500" : "")}
        placeholder="image URL *" value={image}
        onChange={(e) => { setImage(e.target.value); setShowReq(false); }} />
      <div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className={inputC + (showReq && !reqMeta.name ? " ring-1 ring-red-500" : "")}
            placeholder="name *" value={name}
            onChange={(e) => { setName(e.target.value); setShowReq(false); }} />
          <input
            className={inputC + (showReq && !reqMeta.symbol ? " ring-1 ring-red-500" : "")}
            placeholder="symbol *" value={symbol}
            onChange={(e) => { setSymbol(e.target.value); setShowReq(false); }} />
        </div>
        {showReq && missing.length > 0 && (
          <p className="mt-1 text-[11px] font-bold text-red-500">
            {missing.join(", ")} {missing.length === 1 ? "is" : "are"} required.
          </p>
        )}
      </div>
      <div>
        <label className="text-[11px] text-neutral-500">Total supply — how many tokens will ever exist</label>
        <input className={inputC + " mt-1"} placeholder="e.g. 1000000000" inputMode="numeric" value={supply}
          onChange={(e) => setSupply(e.target.value.replace(/[^\d]/g, ""))} />
        <div className="mt-1.5 flex gap-2">
          {[["1M", "1000000"], ["100M", "100000000"], ["1B", "1000000000"]].map(([label, val]) => (
            <button key={label} type="button"
              className="rounded-none border border-neutral-800 px-2.5 py-1 text-[11px] font-bold text-neutral-300 hover:border-white"
              onClick={() => setSupply(val)}>{label}</button>
          ))}
          {supply && <span className="ml-auto self-center text-[11px] text-neutral-500 tabular-nums">{Number(supply).toLocaleString()} tokens · you keep 5%</span>}
        </div>
      </div>
      <textarea className={inputC} placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      <div className="grid grid-cols-1 gap-2">
        <input className={inputC} placeholder="website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <input className={inputC} placeholder="https://x.com/… (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
        <input className={inputC} placeholder="https://t.me/… (optional)" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
      </div>
      <button className={btn} disabled={busy} onClick={launch}>
        {busy ? "launching…" : "Launch Token (0.000002 XNO)"}
      </button>
      <p className="text-[11px] text-neutral-500">creator keeps 5% · 1 raw data fee per op</p>
    </div>
  );
}

function Portfolio({ tokens, onSelect, account, sendOp, busy, usd }: { tokens: Token[]; onSelect: (id: string) => void; account?: string; sendOp: (tokenId: string, op: Op, label: string) => Promise<void>; busy: boolean; usd: number | null }) {
  const mine = tokens.filter((t) => BigInt(t.myBalance) > 0n);
  // Every token game where this wallet has withdrawable in-game XNO — scanned
  // from the whole replayed ledger so forgotten coins are never left behind.
  // Direct tokens settle at sell — the withdraw op does not exist for them.
  const credited = tokens.filter((t) => !t.direct && BigInt(t.myCredit || "0") > 0n);
  const totalCredit = credited.reduce((a, t) => a + BigInt(t.myCredit), 0n);
  const [withdrawing, setWithdrawing] = useState(false);
  const withdrawAll = async () => {
    setWithdrawing(true);
    try {
      // One cheap self-signed block per token — the user pays their own tiny
      // PoW; the operator pays none until the netted settle.
      for (const t of credited) await sendOp(t.tokenId, { kind: "withdraw" }, `withdraw ${tokSym(t)}`);
    } finally { setWithdrawing(false); }
  };
  if (!account) {
    return (
      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-300">Unlock your wallet</p>
        <p className="text-sm mt-1">to see your tokens.</p>
      </div>
    );
  }
  if (mine.length === 0) {
    return (
      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-300">No holdings yet</p>
        <p className="text-sm mt-1">Buy a coin to add it here.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {totalCredit > 0n && (
        <div className="rounded-none border border-neutral-700 bg-neutral-950 p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-400">Game balance — all coins</p>
            <p className="text-base font-black tabular-nums truncate">{fmtXno(totalCredit.toString())} XNO{usd != null && <span className="text-sm font-bold text-neutral-500"> ({fmtUsd(totalCredit.toString(), usd)})</span>}</p>
            <p className="text-[10px] text-neutral-500">across {credited.length} coin{credited.length === 1 ? "" : "s"} — sells you may have forgotten included</p>
          </div>
          <button
            className="shrink-0 rounded-none bg-white px-4 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200 disabled:opacity-40"
            disabled={busy || withdrawing}
            onClick={withdrawAll}
          >
            {withdrawing ? "Withdrawing…" : "Withdraw all"}
          </button>
        </div>
      )}
      <h2 className="text-sm font-bold text-neutral-400">Your holdings</h2>
      <div className="space-y-2">
        {mine.map((t) => {
          const valueRaw = (BigInt(t.myBalance) * BigInt(t.price)) / 10n ** BigInt(t.decimals);
          return (
            <button
              key={t.tokenId}
              onClick={() => onSelect(t.tokenId)}
              className="w-full rounded-none border border-neutral-800 bg-neutral-950 p-3 flex items-center gap-3 text-left hover:border-white"
            >
              <Avatar image={t.image} symbol={tokSym(t)} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-sm truncate">{tokName(t)} <span className="text-[11px] font-normal text-neutral-500">${tokSym(t)}</span></p>
                <p className="text-[11px] text-neutral-500">{fmtTok(t.myBalance, t.decimals)} {tokSym(t)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold">{fmtXno(valueRaw.toString())} XNO</p>
                <p className={"text-[11px] " + (t.change24h == null ? "text-neutral-500" : t.change24h >= 0 ? "text-green-500" : "text-red-500")}>{pctStr(t.change24h)}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const TABS: { id: "explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet"; label: string; icon: string }[] = [
  { id: "explore", label: "Explore", icon: "🏠" },
  { id: "ranks", label: "Ranks", icon: "🏆" },
  { id: "create", label: "Launch", icon: "✨" },
  { id: "scan", label: "Explorer", icon: "🔎" },
  { id: "wallet", label: "Wallet", icon: "👛" },
];

function TabBar({ tab, setTab }: { tab: "explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet"; setTab: (t: "explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet") => void }) {
  return (
    <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-neutral-800 bg-black/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      <div className="w-full grid grid-cols-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={"py-3 text-xs font-bold uppercase tracking-wide border-t-2 " + (tab === t.id ? "text-white border-white" : "text-neutral-500 border-transparent hover:text-white")}
          >
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  );
}