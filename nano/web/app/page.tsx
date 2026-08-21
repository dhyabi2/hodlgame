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
import { sanitizeMeta, sanitizeSymbol } from "../server/validate";
import type { Op } from "../core/ops";
import { Sparkline } from "./components/Sparkline";
import Explorer from "./components/Explorer";
import { loadWallet, saveWallet, removeWallet, encryptSeed, decryptSeed } from "./lib/wallet";
import { useNanoWebsocket } from "./lib/nano-ws";
import { QRCodeSVG } from "qrcode.react";
import { toRaw, clampSlippage, isNanoAddr } from "./lib/trade";

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
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
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

const fmtXno = (raw: string | undefined) => {
  if (!raw) return "0";
  const n = Number(BigInt(raw)) / 1e30;
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 0.000001) return n.toExponential(3);
  return n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
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

const quoteSell = (poolXno: string, poolTokens: string, tokens: bigint): bigint => {
  const px = BigInt(poolXno);
  const pt = BigInt(poolTokens);
  if (px <= 0n || pt <= 0n) return 0n;
  return (tokens * px) / (pt + tokens);
};


const inputC =
  "w-full rounded-none border border-neutral-300 bg-white px-4 py-3 text-sm text-black placeholder-neutral-400 focus:outline-none focus:border-black";
const btn =
  "w-full rounded-none bg-black px-4 py-3 text-sm font-bold text-white hover:bg-neutral-800 disabled:opacity-40 transition";

export default function Home() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Token | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
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
  };
  const lock = () => setKeys(null);
  const remove = () => {
    removeWallet();
    setHasWallet(false);
    setKeys(null);
  };

  useEffect(() => {
    setHasWallet(Boolean(loadWallet()));
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

  // Feed — Vercel-safe polling (no SSE), includes my balance when unlocked.
  useEffect(() => {
    const acct = keys?.address ?? "";
    let live = true;
    const load = async () => {
      try {
        const j = await (await fetch(`/api/state?account=${acct}`)).json();
        if (live) setTokens(j.tokens ?? []);
      } catch {}
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [keys?.address]);

  // Detail — polling.
  useEffect(() => {
    const acct = keys?.address ?? "";
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let live = true;
    const load = async () => {
      try {
        const j = await (await fetch(`/api/token?token=${selectedId}&account=${acct}`)).json();
        if (live && j.token) setDetail(j.token);
      } catch {}
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [selectedId, keys?.address]);

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
    if (!info.frontier) throw new Error("account not opened — fund it first");
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

  return (
    <main className="min-h-screen bg-white text-black pb-20 overflow-x-hidden">
      <header className="sticky top-0 z-20 border-b border-neutral-300 bg-white/90 backdrop-blur">
        <div className="w-full px-4 py-3 flex items-center gap-3 sm:gap-5">
          <button className="text-lg font-black tracking-tight text-black shrink-0" onClick={() => { setSelectedId(null); setTab("explore"); }}>
            HoldFun
          </button>
          {/* Desktop nav only — on mobile the bottom tab bar handles navigation. */}
          <nav className="hidden sm:flex items-center gap-4 text-xs font-bold uppercase tracking-wide text-neutral-500 min-w-0 overflow-x-auto">
            {([["explore", "Coins"], ["ranks", "Ranks"], ["scan", "Explorer"], ["wallet", "Wallet"]] as const).map(([id, label]) => (
              <button key={id} className={"hover:text-black whitespace-nowrap " + (!selectedId && tab === id ? "text-black" : "")} onClick={() => { setSelectedId(null); setTab(id); }}>{label}</button>
            ))}
            <a className="hover:text-black whitespace-nowrap" href="/pro">Chart / Trade ↗</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <button
              className="hidden sm:inline-block rounded-none bg-black px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-neutral-800"
              onClick={() => { setSelectedId(null); setTab("create"); }}
            >
              + Create
            </button>
            {keys ? (
              <button
                className="text-xs text-neutral-700 font-mono hover:text-black"
                title="wallet"
                onClick={() => { setSelectedId(null); setTab("wallet"); }}
              >
                {short(keys.address)}
              </button>
            ) : (
              <button className="text-xs text-black font-bold uppercase tracking-wide" onClick={promptUnlock}>
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
                submitBlock={submitBlock}
                sendOp={sendOp}
                promptUnlock={promptUnlock}
                onBack={() => setSelectedId(null)}
              />
            </div>
          ) : (
            // Deep-linked / just-selected coin whose detail is still loading — show
            // a loading card, never the empty "No coins yet" feed (which made a
            // shared coin link look broken).
            <div className="w-full max-w-3xl mx-auto">
              <button onClick={() => setSelectedId(null)} className="text-xs text-neutral-500 hover:text-black">← all coins</button>
              <div className="mt-4 rounded-none border border-neutral-300 bg-white p-10 text-center text-neutral-500 animate-pulse">loading coin…</div>
            </div>
          )
        ) : tab === "explore" ? (
          <Feed tokens={tokens} onSelect={(id) => setSelectedId(id)} myAddress={keys?.address} />
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
            {keys && <Portfolio tokens={tokens} onSelect={(id) => setSelectedId(id)} account={keys.address} />}
          </div>
        )}

      </div>

      {toast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-none border border-black bg-white px-4 py-2 text-sm shadow-lg max-w-[90vw] truncate">
          {toast}
        </div>
      )}

      <TabBar tab={tab} setTab={setTab} />

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
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setPw(""); setErr(""); } }, [open]);
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

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full rounded-none sm:rounded-none border border-neutral-300 bg-white p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-neutral-800">{hasWallet ? "Unlock wallet" : "Set up your wallet"}</p>
          <button className="text-neutral-500 hover:text-neutral-700 text-lg leading-none" onClick={onClose}>×</button>
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
            {err && <p className="text-xs text-black">{err}</p>}
            <button className={btn} disabled={busy} onClick={unlock}>{busy ? "unlocking…" : "Unlock"}</button>
            <p className="text-[11px] text-neutral-400">decrypted in your browser — your seed never leaves it</p>
          </>
        ) : (
          <>
            <p className="text-xs text-neutral-600">You need a wallet to trade. It’s created and encrypted right in your browser — takes a few seconds.</p>
            <button className={btn} onClick={goSetup}>Create / import wallet →</button>
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
    } catch (e: any) {
      if (announce) say("receive failed: " + (e?.message ?? e));
    } finally {
      receivingRef.current = false;
      setReceiving(false);
    }
  };

  useEffect(() => {
    refresh();
    receiveAll(false); // auto-sweep pending on unlock
    // Poll also auto-receives (silently) so the balance always reflects deposits
    // even if the websocket missed one; the guard prevents overlap.
    const t = setInterval(() => receiveAll(false), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.address]);

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
    <div className="rounded-none border border-neutral-300 bg-white p-5 space-y-4">
      <div>
        <p className="text-[11px] text-neutral-500 mb-1">balance</p>
        <p className="text-3xl font-black">{balance == null ? "…" : fmtXno(balance)} <span className="text-lg text-neutral-500">XNO</span></p>
      </div>

      <div className="rounded-none border border-neutral-300 bg-neutral-50 p-3">
        <p className="text-[11px] text-neutral-500 mb-2">your address · scan or send XNO here to fund</p>
        <div className="flex items-start gap-3">
          <div className="shrink-0 border border-neutral-300 bg-white p-1.5">
            <QRCodeSVG value={`nano:${keys.address}`} size={112} bgColor="#ffffff" fgColor="#000000" level="M" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block text-xs font-mono text-neutral-700 break-all">{keys.address}</span>
            <button className="rounded-none bg-neutral-100 px-2.5 py-1.5 text-[11px] font-bold text-neutral-700 hover:bg-neutral-200" onClick={copy}>
              {copied ? "copied" : "copy address"}
            </button>
            <p className="text-[10px] text-neutral-400">deposits are detected live and received automatically</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className="rounded-none border border-neutral-300 py-3 text-sm font-bold text-neutral-800 hover:border-black disabled:opacity-40"
          disabled={receiving}
          onClick={() => receiveAll(true)}
        >
          {receiving ? "receiving…" : "Receive pending"}
        </button>
        <button
          className="rounded-none border border-neutral-300 py-3 text-sm font-bold text-neutral-800 hover:border-black"
          onClick={() => setReveal((v) => !v)}
        >
          Back up seed
        </button>
      </div>

      {reveal && (
        <div className="rounded-none border border-neutral-400 bg-neutral-100 p-3 space-y-2">
          <p className="text-[11px] text-black font-bold">Your seed is full control of this wallet. Never share it. Anyone with it can drain your funds.</p>
          {!revealed ? (
            <>
              <input className={inputC} type="password" placeholder="wallet password" value={revealPw} onChange={(e) => setRevealPw(e.target.value)} />
              {revealErr && <p className="text-xs text-black">{revealErr}</p>}
              <div className="flex gap-2">
                <button className={btn} onClick={doReveal}>Reveal seed</button>
                <button className="rounded-none border border-neutral-300 px-4 py-3 text-sm font-bold text-neutral-600" onClick={closeReveal}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-mono text-black break-all select-all bg-neutral-100 rounded-none p-2">{revealed}</p>
              <div className="flex gap-2">
                <button
                  className="rounded-none bg-neutral-100 px-4 py-2 text-sm font-bold text-neutral-800 hover:bg-neutral-200"
                  onClick={() => navigator.clipboard.writeText(revealed).catch(() => {})}
                >
                  Copy seed
                </button>
                <button className="rounded-none border border-neutral-300 px-4 py-2 text-sm font-bold text-neutral-600" onClick={closeReveal}>Hide</button>
              </div>
            </>
          )}
        </div>
      )}

      <button className="w-full rounded-none border border-neutral-300 px-4 py-3 text-sm font-bold text-neutral-800 hover:border-black" onClick={lock}>
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
      <div className="rounded-none border border-neutral-300 bg-white p-4 space-y-2">
        <p className="text-sm font-bold text-neutral-700">Open wallet</p>
        <input className={inputC} type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="text-xs text-black">{err}</p>}
        <div className="flex gap-2">
          <button className={btn} disabled={busy} onClick={open}>
            {busy ? "opening…" : "Open"}
          </button>
          <button className="rounded-none border border-neutral-300 px-4 py-3 text-sm font-bold text-black hover:border-black" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-neutral-300 bg-white p-4 space-y-2">
      <div className="flex gap-2">
        <button className={"px-4 py-2 rounded-none text-sm font-bold " + (mode === "create" ? "bg-black text-white" : "text-neutral-500")} onClick={() => setMode("create")}>
          Create
        </button>
        <button className={"px-4 py-2 rounded-none text-sm font-bold " + (mode === "import" ? "bg-black text-white" : "text-neutral-500")} onClick={() => setMode("import")}>
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
      {err && <p className="text-xs text-black">{err}</p>}
      <button className={btn} disabled={busy} onClick={mode === "create" ? create : importSeed}>
        {busy ? "encrypting…" : mode === "create" ? "Create wallet" : "Encrypt & unlock"}
      </button>
      <p className="text-[11px] text-neutral-400">seed is encrypted in your browser (PBKDF2 + AES-GCM) and never leaves it</p>
    </div>
  );
}

// Derived status surfaces (docs/GROWTH-MECHANICS.md §4): token / creator /
// holder leaderboards, recomputed from public state — status is earned, not
// decreed. Endogenous competition: the prize is visibility, which is free.
interface TokenRank { tokenId: string; name: string; symbol: string; image: string; price: string; marketCap: string; change24h: number | null; holders: number; volume: string; createdAt: number }
interface CreatorRank { account: string; tokenCount: number; holders: number; marketCap: string; volume: string; score: number; badges: string[]; topSymbols: string[] }
interface HolderRank { account: string; tokensHeld: number; value: string; badges: string[] }
interface LB { updatedAt: number; tokens: { byVolume: TokenRank[]; byGainers: TokenRank[]; byHolders: TokenRank[]; newest: TokenRank[] }; creators: CreatorRank[]; holders: HolderRank[] }

function Ranks({ onSelect, myAddress }: { onSelect: (id: string) => void; myAddress?: string }) {
  const [lb, setLb] = useState<LB | null>(null);
  const [board, setBoard] = useState<"byVolume" | "byGainers" | "byHolders" | "newest">("byVolume");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const j = await (await fetch("/api/leaderboards")).json(); if (live && !j.error) setLb(j); } catch {}
    };
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!lb) {
    return <div className="grid gap-3 sm:grid-cols-2"><Skel /><Skel /><Skel /><Skel /></div>;
  }
  const empty = lb.tokens.byVolume.length === 0;
  if (empty) {
    return (
      <div className="rounded-none border border-neutral-300 bg-white p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-700">No ranks yet</p>
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
      <div className="grid gap-4 lg:grid-cols-2">
        {/* token leaderboard */}
        <section className="rounded-none border border-neutral-300 bg-white p-4">
          <div className="flex items-center gap-1 mb-3 overflow-x-auto">
            {boards.map((b) => (
              <button key={b.k}
                className={"rounded-none px-2.5 py-1 text-xs font-bold whitespace-nowrap " + (board === b.k ? "bg-black text-white" : "text-neutral-500 hover:text-neutral-700")}
                onClick={() => setBoard(b.k)}>{b.label}</button>
            ))}
          </div>
          <div className="space-y-1">
            {rows.map((t, i) => (
              <button key={t.tokenId} onClick={() => onSelect(t.tokenId)}
                className="flex w-full items-center gap-3 rounded-none px-2 py-2 text-left hover:bg-neutral-50">
                <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
                <Avatar image={t.image} symbol={tokSym(t)} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold truncate">{tokSym(t)} <span className="text-[11px] font-normal text-neutral-500">{t.name}</span></p>
                  <p className="text-[11px] text-neutral-500 truncate">mc {fmtXno(t.marketCap)} · {t.holders} hodl · vol {fmtXno(t.volume)}</p>
                </div>
                <span className={"text-xs font-bold tabular-nums shrink-0 " + (t.change24h == null ? "text-neutral-400" : t.change24h >= 0 ? "text-black" : "text-black")}>{pctStr(t.change24h)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* creators */}
        <section className="rounded-none border border-neutral-300 bg-white p-4">
          <p className="text-sm font-bold text-neutral-700 mb-3">Top creators</p>
          <div className="space-y-1">
            {lb.creators.map((c, i) => (
              <div key={c.account} className={"flex items-center gap-3 rounded-none px-2 py-2 " + (c.account === myAddress ? "bg-neutral-100" : "")}>
                <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-mono text-neutral-700 truncate">{short(c.account)}{c.account === myAddress && <span className="text-black"> · you</span>}</p>
                  <p className="text-[11px] text-neutral-500 truncate">{c.tokenCount} coins · {c.holders} holders · {c.topSymbols.join(" ")}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <span className="text-xs font-black text-black tabular-nums">{c.score.toLocaleString()}</span>
                  {c.badges.length > 0 && <span className="text-[10px]">{c.badges.join(" ")}</span>}
                </div>
              </div>
            ))}
            {lb.creators.length === 0 && <p className="text-xs text-neutral-400 py-4 text-center">no creators yet</p>}
          </div>
        </section>
      </div>

      {/* holders */}
      <section className="rounded-none border border-neutral-300 bg-white p-4">
        <p className="text-sm font-bold text-neutral-700 mb-3">Top holders</p>
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {lb.holders.map((h, i) => (
            <div key={h.account} className={"flex items-center gap-3 rounded-none px-2 py-1.5 " + (h.account === myAddress ? "bg-neutral-100" : "")}>
              <span className={"w-5 text-center text-xs font-black " + medal(i)}>{i + 1}</span>
              <p className="min-w-0 flex-1 text-sm font-mono text-neutral-700 truncate">{short(h.account)}{h.account === myAddress && <span className="text-black"> · you</span>}</p>
              <span className="text-[10px] shrink-0">{h.badges.join(" ")}</span>
              <span className="text-xs font-bold tabular-nums shrink-0">{fmtXno(h.value)} XNO</span>
            </div>
          ))}
          {lb.holders.length === 0 && <p className="text-xs text-neutral-400 py-4 text-center">no holders yet</p>}
        </div>
      </section>
    </div>
  );
}
const medal = (i: number) => (i === 0 ? "text-black" : i === 1 ? "text-neutral-700" : i === 2 ? "text-black" : "text-neutral-400");
function Skel() { return <div className="h-40 rounded-none border border-neutral-300 bg-white animate-pulse" />; }

function Feed({ tokens, onSelect, myAddress }: { tokens: Token[]; onSelect: (id: string) => void; myAddress?: string }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"mc" | "price" | "change" | "vol" | "new">("mc");

  const filtered = tokens
    .filter((t) => {
      const q = query.trim().toLowerCase();
      // Search matches ANY identifying field (name / symbol / tokenId) across all
      // tokens, so a coin is findable even before its metadata loads.
      if (q) {
        return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.tokenId.toLowerCase().includes(q);
      }
      // No query → "live" coins: has a name/symbol, real liquidity, OR you hold
      // it (so a creator always sees their own coin even before naming/seeding).
      // Hides only fully-abandoned launches you don't hold.
      return Boolean(t.name || t.symbol) || BigInt(t.poolXno) > 0n || BigInt(t.myBalance) > 0n;
    })
    .slice()
    .sort((a, b) => {
      switch (sort) {
        case "price": return BigInt(b.price) > BigInt(a.price) ? 1 : -1;
        case "change": return (b.change24h ?? -1e9) - (a.change24h ?? -1e9);
        case "vol": return BigInt(b.buyVolume) > BigInt(a.buyVolume) ? 1 : -1;
        case "new": return b.createdAt - a.createdAt;
        default: return BigInt(b.marketCap) > BigInt(a.marketCap) ? 1 : -1;
      }
    });

  if (tokens.length === 0) {
    return (
      <div className="rounded-none border border-neutral-300 bg-white p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-700">No coins yet</p>
        <p className="text-sm mt-1">Start a new coin to launch the first one on Nano.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold text-neutral-600 shrink-0">Coins</h2>
        <input
          className={inputC + " py-2"}
          placeholder="search name / symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="rounded-none border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-700 shrink-0"
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
      {filtered.length === 0 && <p className="text-sm text-neutral-400 py-6 text-center">No coins match.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.map((t) => (
          <button
            key={t.tokenId}
            onClick={() => onSelect(t.tokenId)}
            className="rounded-none border border-neutral-300 bg-white p-4 text-left hover:border-black transition group"
          >
            <div className="flex items-center gap-3">
              <Avatar image={t.image} symbol={tokSym(t)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="font-bold text-sm truncate">{tokName(t)}</p>
                  <p className="text-[11px] text-neutral-500 shrink-0">${tokSym(t)}</p>
                </div>
                <p className="text-[11px] text-neutral-500 truncate">mc {fmtXno(t.marketCap)} XNO</p>
              </div>
              <Sparkline points={t.spark} width={64} height={26} color={trendColor(t.spark)} />
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-neutral-500">
              <span className={"font-bold shrink-0 " + (t.change24h == null ? "text-neutral-400" : t.change24h >= 0 ? "text-black" : "text-black")}>
                {pctStr(t.change24h)}
              </span>
              <span className="truncate text-neutral-600">{fmtXno(t.price)} XNO</span>
              <span className="shrink-0">{t.holders} hodl</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function trendColor(points: PricePoint[]): string {
  if (points.length < 2) return "#000000";
  const a = BigInt(points[0].priceRaw);
  const b = BigInt(points[points.length - 1].priceRaw);
  return b >= a ? "#000000" : "#666666";
}

// Public IPFS gateways tried in order; images are stored as ipfs://CID so any
// gateway (or a community pin) can serve them — no single pinning account.
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

/** Resolve an image URL to an ordered candidate list (ipfs:// and legacy
 * gateway URLs fan out across gateways; anything else passes through). */
function imageCandidates(url: string): string[] {
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
      className="rounded-full bg-black flex items-center justify-center font-black text-white shrink-0"
    >
      {(symbol || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}

function TokenDetail({
  token,
  keys,
  busy,
  say,
  submitBlock,
  sendOp,
  promptUnlock,
  onBack,
}: {
  token: Token;
  keys: Keys | null;
  busy: boolean;
  say: (s: string) => void;
  submitBlock: (link: string, delta: bigint) => Promise<string>;
  sendOp: (tokenId: string, op: Op, label: string) => Promise<void>;
  promptUnlock: () => void;
  onBack: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [tab, setTab] = useState<"trade" | "thread">("trade");
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
  const [xnoBal, setXnoBal] = useState("0");

  // Live XNO balance for the trade/seed MAX buttons.
  useEffect(() => {
    if (!keys) { setXnoBal("0"); return; }
    let live = true;
    const load = () => rpc("account_info", { account: keys.address }).then((i) => live && setXnoBal(i.balance ?? "0")).catch(() => live && setXnoBal("0"));
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, [keys?.address, busy]);

  const myHolding = keys ? token.topHolders.find((h) => h.account === keys.address) : undefined;
  const isCreator = keys?.address === token.creator;

  async function buy() {
    if (!keys) return promptUnlock();
    if (!token.pool) return say("this token has no pool yet");
    const raw = toRaw(amount, 30);
    if (raw <= 0n) return say("enter XNO amount");
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("account not opened — fund it first");

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
    } catch (e: any) {
      say("buy failed: " + e.message);
    }
  }

  async function sell() {
    if (!keys) return promptUnlock();
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
        say("sell ✓");
      } else {
        await sendOp(token.tokenId, { kind: "sell", tokens: raw, minXno: 0n }, "sell");
      }
    } catch (e: any) {
      say("sell failed: " + e.message);
    }
  }

  // Creator seeds/adds pool liquidity: deposit XNO to the pool (value-bound),
  // then a chained seedLiq op moving `tokens` from treasury into the pool. This
  // is what makes a launched token tradeable — mirrors the buy deposit+op flow.
  async function seed() {
    if (!keys) return promptUnlock();
    if (!token.pool) return say("no pool derived for this token yet");
    if (keys.address !== token.creator) return say("only the creator can seed liquidity");
    const xnoRaw = toRaw(seedXno, 30);
    const tokRaw = toRaw(seedTokens, token.decimals);
    if (xnoRaw <= 0n) return say("enter XNO amount to seed");
    if (tokRaw <= 0n) return say("enter token amount to seed");
    if (tokRaw > BigInt(token.treasury)) return say("token amount exceeds treasury");
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("account not opened — fund it first");
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
      say(`liquidity seeded ✓ ${r2.hash.slice(0, 10)}…`);
      setSeedXno(""); setSeedTokens("");
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
    if (raw > BigInt(myHolding?.balanceRaw ?? "0")) return say(`you only hold ${fmtTok(myHolding?.balanceRaw, token.decimals)} ${tokSym(token)}`);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-700">← all coins</button>
        <a href={`/pro?token=${token.tokenId}`} className="rounded-none border border-neutral-300 px-2.5 py-1 text-[11px] font-bold text-black hover:border-black">
          Pro terminal ↗
        </a>
      </div>

      <div className="rounded-none border border-neutral-300 bg-white p-5">
        <div className="flex items-center gap-3">
          <Avatar image={token.image} symbol={tokSym(token)} size={48} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-black truncate">{tokName(token)}</h2>
              <span className="text-[11px] text-neutral-500">${tokSym(token)}</span>
            </div>
            <p className="text-[11px] text-neutral-400 font-mono truncate">{token.tokenId}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-base sm:text-2xl font-black whitespace-nowrap">{fmtXno(token.marketCap)} XNO</p>
            <p className="text-[11px] text-neutral-500 whitespace-nowrap">
              market cap · <span className="text-black">{pctStr(token.change24h)}</span>
            </p>
          </div>
        </div>
        {token.description && <p className="text-sm text-neutral-600 mt-3">{token.description}</p>}
        <div className="flex gap-3 mt-3">
          {token.website && <SocialLink href={token.website} label="website" />}
          {token.twitter && <SocialLink href={token.twitter} label="X" />}
          {token.telegram && <SocialLink href={token.telegram} label="telegram" />}
        </div>
        <div className="flex items-center gap-3 mt-4 text-[11px] text-neutral-500">
          <span>dev {short(token.creator)}</span>
          <span>holders {token.holders}</span>
          <span>price {fmtXno(token.price)} XNO</span>
        </div>
      </div>

      <div className="rounded-none border border-neutral-300 bg-white p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-neutral-700">Price</p>
          <div className="flex items-center gap-3 text-[11px] text-neutral-500">
            <span>liq {fmtXno(token.poolXno)} XNO</span>
            <span>reserve {fmtTok(token.poolTokens, token.decimals)} {tokSym(token)}</span>
          </div>
        </div>
        {token.series.length >= 2 ? (
          <PriceChart series={token.series} trades={token.trades} decimals={token.decimals} symbol={tokSym(token)} />
        ) : (
          <div className="h-40 flex items-center justify-center text-neutral-400 text-sm">trades chart the price</div>
        )}
        <ProgressBar token={token} />
      </div>

      <div className="rounded-none border border-neutral-300 bg-white p-5">
        <div className="flex items-center gap-2 mb-3">
          <button
            className={"px-4 py-2 rounded-none text-sm font-bold " + (tab === "trade" ? "bg-black text-white" : "text-neutral-500")}
            onClick={() => setTab("trade")}
          >
            Trade
          </button>
          <button
            className={"px-4 py-2 rounded-none text-sm font-bold " + (tab === "thread" ? "bg-black text-white" : "text-neutral-500")}
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
          />
        ) : (
          <CommentThread tokenId={token.tokenId} comments={token.comments} keys={keys} isDev={keys?.address === token.creator} />
        )}
      </div>

      {isCreator && keys && <EditCoinInfo token={token} keys={keys} say={say} />}

      {isCreator && (
        <div className="rounded-none border border-black bg-white p-5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-black">Seed / add liquidity <span className="text-[11px] font-normal text-neutral-500">creator</span></p>
            <p className="text-[11px] text-neutral-500">pool {fmtXno(token.poolXno)} XNO · treasury {fmtTok(token.treasury, token.decimals)}</p>
          </div>
          {BigInt(token.poolXno) <= 0n && (
            <p className="text-[11px] text-black">This token has no pool yet — seed it to make it tradeable.</p>
          )}
          <div className="flex gap-2">
            <input className={inputC} placeholder="XNO to add" inputMode="decimal" value={seedXno} onChange={(e) => setSeedXno(e.target.value)} />
            <input className={inputC} placeholder="tokens to add" inputMode="decimal" value={seedTokens} onChange={(e) => setSeedTokens(e.target.value)} />
          </div>
          <button className={btn} disabled={busy} onClick={seed}>Seed pool</button>
        </div>
      )}

      <div className="rounded-none border border-neutral-300 bg-white p-5 space-y-2">
        <p className="text-sm font-bold text-neutral-700">Send tokens</p>
        <input className={inputC} placeholder="nano_… recipient" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
        <div className="flex gap-2">
          <input className={inputC} placeholder="amount" inputMode="decimal" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
          <button className="rounded-none bg-neutral-100 px-4 py-3 text-sm font-bold hover:bg-neutral-200 shrink-0 disabled:opacity-40" disabled={busy} onClick={transfer}>
            Send
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TradesPanel trades={token.trades} />
        <HoldersPanel holders={token.topHolders} creator={token.creator} decimals={token.decimals} />
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
    <a href={safe} target="_blank" rel="noreferrer" className="text-[11px] text-black hover:underline">
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
      <div className="h-2 rounded-full bg-neutral-100 overflow-hidden">
        <div className="h-full bg-black" style={{ width: `${Math.min(100, pct)}%` }} />
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
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const slip = clampSlippage(slippage);

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
      return { outStr: fmtTok(out.toString(), token.decimals), unit: token.symbol, minStr: fmtTok(min.toString(), token.decimals), impact };
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
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span>balance: {side === "buy" ? `${fmtXno(xnoBal)} XNO` : `${fmtTok(myHolding?.balanceRaw, token.decimals)} ${tokSym(token)}`}</span>
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-400">slippage %</span>
          <input
            className="w-14 rounded-none bg-white border border-neutral-300 px-2 py-1 text-xs text-black text-right"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
        </label>
      </div>
      {slip > 0 && <p className="text-[10px] text-neutral-400">min-received enforced on-chain via fragment links</p>}
      <div className="grid grid-cols-2 gap-2">
        <button
          className={"rounded-none py-2 text-sm font-bold " + (side === "buy" ? "bg-black text-white" : "bg-neutral-100 text-neutral-600")}
          onClick={() => setSide("buy")}
        >
          Buy
        </button>
        <button
          className={"rounded-none py-2 text-sm font-bold " + (side === "sell" ? "bg-black text-white" : "bg-neutral-100 text-neutral-600")}
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
            className="shrink-0 rounded-none bg-neutral-100 px-3 text-xs font-bold text-neutral-700 hover:bg-neutral-200 disabled:opacity-40"
            disabled={BigInt(xnoBal) <= 0n}
            onClick={() => { const usable = BigInt(xnoBal) - 10n ** 24n; setAmount(usable > 0n ? fmtXno(usable.toString()) : "0"); }}
          >
            Max
          </button>
        )}
        {side === "sell" && myHolding && (
          <button
            className="shrink-0 rounded-none bg-neutral-100 px-3 text-xs font-bold text-neutral-700 hover:bg-neutral-200"
            onClick={() => setAmount(fmtTok(myHolding.balanceRaw, token.decimals))}
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
                className="rounded-none border border-neutral-300 py-1.5 text-xs font-bold text-neutral-600 hover:border-black hover:text-black disabled:opacity-40 disabled:hover:border-neutral-300 disabled:hover:text-neutral-600"
                onClick={() => setAmount(v)}
              >
                {v} XNO
              </button>
            );
          })}
        </div>
      )}
      {quote && (
        <div className="rounded-none border border-neutral-300 bg-neutral-50 p-3 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-neutral-500">you receive ≈</span>
            <span className="font-bold text-black">{quote.outStr} {quote.unit}</span>
          </div>
          {slip > 0 && (
            <div className="flex justify-between">
              <span className="text-neutral-500">minimum received</span>
              <span className="text-neutral-700">{quote.minStr} {quote.unit}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-neutral-500">price impact</span>
            <span className={quote.impact >= 5 ? "text-black" : quote.impact >= 1 ? "text-black" : "text-black"}>
              {quote.impact.toFixed(2)}%
            </span>
          </div>
        </div>
      )}
      <button className={btn} disabled={busy} onClick={side === "buy" ? buy : sell}>
        {busy ? "…" : side === "buy" ? "Buy (send XNO)" : "Sell tokens"}
      </button>

      <StakeBox token={token} busy={busy} sendOp={sendOp} />

      {token.pool && <p className="text-[11px] text-neutral-400 font-mono break-all">pool: {token.pool}</p>}
    </div>
  );
}

// Staking: real amount inputs (no more hardcoded amounts) plus a live readout
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
  const staked = BigInt(token.myStaked || "0");
  const claimable = BigInt(token.myClaimable || "0");
  const bal = BigInt(token.myBalance || "0");

  const doStake = () => {
    const raw = toRaw(stakeAmt, token.decimals);
    if (raw <= 0n) return;
    sendOp(token.tokenId, { kind: "stake", amount: raw }, "stake").then(() => setStakeAmt(""));
  };
  const doUnstake = () => {
    const raw = toRaw(unstakeAmt, token.decimals);
    if (raw <= 0n) return;
    sendOp(token.tokenId, { kind: "unstake", amount: raw }, "unstake").then(() => setUnstakeAmt(""));
  };

  return (
    <div className="rounded-none border border-neutral-300 bg-neutral-50 p-3 space-y-3">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-neutral-600 font-bold">Stake · earn XNO rebates</span>
        <span className="text-neutral-500">staked {fmtTok(token.myStaked, token.decimals)} {token.symbol}</span>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            className={inputC}
            placeholder="stake amount"
            inputMode="decimal"
            value={stakeAmt}
            onChange={(e) => setStakeAmt(e.target.value)}
          />
          {bal > 0n && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-neutral-600 hover:text-black"
              onClick={() => setStakeAmt(fmtTok(token.myBalance, token.decimals))}
            >
              MAX
            </button>
          )}
        </div>
        <ActionBtn disabled={busy || bal <= 0n} onClick={doStake}>Stake</ActionBtn>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            className={inputC}
            placeholder="unstake amount"
            inputMode="decimal"
            value={unstakeAmt}
            onChange={(e) => setUnstakeAmt(e.target.value)}
          />
          {staked > 0n && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-neutral-600 hover:text-black"
              onClick={() => setUnstakeAmt(fmtTok(token.myStaked, token.decimals))}
            >
              MAX
            </button>
          )}
        </div>
        <ActionBtn disabled={busy || staked <= 0n} onClick={doUnstake}>Unstake</ActionBtn>
      </div>
      {unstakeAmt && Number(unstakeAmt) > 0 && (
        <p className="text-[10px] text-black">20% exit tax on unstake (5% burned, 15% to stakers)</p>
      )}

      <div className="flex items-center justify-between border-t border-neutral-300 pt-2">
        <span className="text-[11px] text-neutral-500">claimable ≈ <span className="text-black font-bold">{fmtXno(token.myClaimable)} XNO</span></span>
        <button
          className="rounded-none bg-neutral-100 border border-black px-3 py-1.5 text-[11px] font-bold text-black hover:bg-neutral-200 disabled:opacity-40"
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
    <button className="rounded-none border border-neutral-300 py-3 text-sm font-bold text-neutral-800 hover:border-black disabled:opacity-40" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function TradesPanel({ trades }: { trades: Trade[] }) {
  return (
    <div className="rounded-none border border-neutral-300 bg-white p-4">
      <p className="text-sm font-bold text-neutral-700 mb-2">Recent trades</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {trades.length === 0 && <p className="text-xs text-neutral-400">no trades yet</p>}
        {trades.map((t, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 font-mono">{short(t.account)}</span>
            <span className={t.kind === "buy" ? "text-black" : "text-black"}>
              {t.kind === "buy" ? "▲" : "▼"} {t.kind}
            </span>
            <span className="text-neutral-600">{fmtXno(t.priceRaw)}</span>
            <span className="text-neutral-400">{timeAgo(t.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldersPanel({ holders, creator, decimals }: { holders: Holder[]; creator: string; decimals: number }) {
  const top = holders.slice(0, 20);
  return (
    <div className="rounded-none border border-neutral-300 bg-white p-4">
      <p className="text-sm font-bold text-neutral-700 mb-2">Top holders</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {top.map((h, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-neutral-500 font-mono flex items-center gap-1">
              {i + 1}. {short(h.account)} {h.account === creator && <span className="text-black">dev</span>}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-neutral-600">{fmtTok(h.balanceRaw, decimals)}</span>
              <span className="text-neutral-400 w-12 text-right">{h.pct.toFixed(2)}%</span>
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
        {all.length === 0 && <p className="text-xs text-neutral-400">be the first to comment</p>}
        {all.map((c) => (
          <div key={c.id} className="rounded-none bg-neutral-50 p-2.5">
            <p className="text-[11px] text-neutral-500 font-mono">{short(c.account)} · {timeAgo(c.time)}</p>
            <p className="text-xs text-neutral-700 mt-1">{c.text}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={inputC} placeholder="say something…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="shrink-0 rounded-none bg-neutral-100 px-4 py-3 text-sm font-bold hover:bg-neutral-200" onClick={post}>
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
    if (!meta.name || !meta.symbol) return say("name and symbol are required");
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
    <div className="rounded-none border border-black bg-white p-5 space-y-2">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-bold text-black">Coin info <span className="text-[11px] font-normal text-neutral-500">creator</span></span>
        <span className="text-neutral-400 text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {!token.name && !token.symbol && <p className="text-[11px] text-black">This coin has no name yet — set it here so it shows everywhere.</p>}
      {open && (
        <>
          <div className="flex items-center gap-3">
            <Avatar image={image} symbol={symbol || token.tokenId.slice(0, 2)} size={44} />
            <label className="text-xs text-black cursor-pointer">
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

  async function upload(file: File) {
    if (!file.type.startsWith("image/")) return say("please choose an image file");
    setUploading(true);
    try {
      // Downscale + normalize in the browser first; fall back to the raw file
      // only if canvas resizing isn't available.
      let body: Blob = file;
      try {
        const r = await resizeImageFile(file, 512);
        body = r.blob;
        say(`image resized to ${r.w}×${r.h}`);
      } catch {
        /* keep original; the server still validates it */
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

  async function launch() {
    if (!keys) return promptUnlock();
    const decimals = 6;
    // Exact BigInt math — `Number(supply) * 10**decimals` loses precision above
    // 2^53. `supply` is a digits-only string, so BigInt(supply) is exact.
    const whole = /^\d+$/.test(supply.trim()) ? BigInt(supply.trim()) : 0n;
    const rawSupply = whole * 10n ** BigInt(decimals);
    // Name + symbol are REQUIRED. Validate the SANITIZED values (the same ones
    // the server verifies and stores) BEFORE any on-chain block, so the form can
    // never mint a nameless coin — a symbol of only invalid chars sanitizes to
    // "" and is rejected here, not silently launched.
    const meta = sanitizeMeta({ name, symbol, decimals, image, description, website, twitter, telegram });
    if (!meta.name || !meta.symbol) {
      setShowReq(true);
      return say("name and symbol are required");
    }
    setShowReq(false);
    if (rawSupply <= 0n) return say("enter supply");
    if (whole > 1_000_000_000_000_000n) return say("supply too large (max 1 quadrillion tokens)");
    setBusy(true);
    try {
      const hash = await submitBlock(
        encodeOpLink("", { kind: "launch", supply: rawSupply, name: meta.name, symbol: meta.symbol, decimals, image: "" }),
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
      onCreated(tokenId);
    } catch (e: any) {
      say("launch failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-none border border-neutral-300 bg-white p-5 space-y-3">
      <h3 className="font-black text-lg">Start a new coin</h3>
      <div className="flex items-center gap-3">
        <Avatar image={image} symbol={symbol} size={56} />
        <label className="text-xs text-black cursor-pointer">
          {uploading ? "uploading…" : "upload image"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <span className="text-[11px] text-neutral-400">or a URL below</span>
      </div>
      <input className={inputC} placeholder="image URL (optional)" value={image} onChange={(e) => setImage(e.target.value)} />
      <div>
        <div className="grid grid-cols-2 gap-2">
          <input
            className={inputC + (showReq && !name.trim() ? " ring-1 ring-red-500" : "")}
            placeholder="name *" value={name}
            onChange={(e) => { setName(e.target.value); setShowReq(false); }} />
          <input
            className={inputC + (showReq && !sanitizeSymbol(symbol) ? " ring-1 ring-red-500" : "")}
            placeholder="symbol *" value={symbol}
            onChange={(e) => { setSymbol(e.target.value); setShowReq(false); }} />
        </div>
        {showReq && (
          <p className="mt-1 text-[11px] font-bold text-red-600">Name and symbol are required.</p>
        )}
      </div>
      <div>
        <label className="text-[11px] text-neutral-500">Total supply — how many tokens will ever exist</label>
        <input className={inputC + " mt-1"} placeholder="e.g. 1000000000" inputMode="numeric" value={supply}
          onChange={(e) => setSupply(e.target.value.replace(/[^\d]/g, ""))} />
        <div className="mt-1.5 flex gap-2">
          {[["1M", "1000000"], ["100M", "100000000"], ["1B", "1000000000"]].map(([label, val]) => (
            <button key={label} type="button"
              className="rounded-none border border-neutral-300 px-2.5 py-1 text-[11px] font-bold text-neutral-700 hover:border-black"
              onClick={() => setSupply(val)}>{label}</button>
          ))}
          {supply && <span className="ml-auto self-center text-[11px] text-neutral-400 tabular-nums">{Number(supply).toLocaleString()} tokens · you keep 5%</span>}
        </div>
      </div>
      <textarea className={inputC} placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      <div className="grid grid-cols-1 gap-2">
        <input className={inputC} placeholder="website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
        <input className={inputC} placeholder="https://x.com/… (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
        <input className={inputC} placeholder="https://t.me/… (optional)" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
      </div>
      <button className={btn} disabled={busy} onClick={launch}>
        {busy ? "launching…" : "Create coin (0.000002 XNO)"}
      </button>
      <p className="text-[11px] text-neutral-400">creator keeps 5% · 1 raw data fee per op</p>
    </div>
  );
}

function Portfolio({ tokens, onSelect, account }: { tokens: Token[]; onSelect: (id: string) => void; account?: string }) {
  const mine = tokens.filter((t) => BigInt(t.myBalance) > 0n);
  if (!account) {
    return (
      <div className="rounded-none border border-neutral-300 bg-white p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-700">Unlock your wallet</p>
        <p className="text-sm mt-1">to see your tokens.</p>
      </div>
    );
  }
  if (mine.length === 0) {
    return (
      <div className="rounded-none border border-neutral-300 bg-white p-10 text-center text-neutral-500">
        <p className="font-bold text-neutral-700">No holdings yet</p>
        <p className="text-sm mt-1">Buy a coin to add it here.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-bold text-neutral-600">Your holdings</h2>
      <div className="space-y-2">
        {mine.map((t) => {
          const valueRaw = (BigInt(t.myBalance) * BigInt(t.price)) / 10n ** BigInt(t.decimals);
          return (
            <button
              key={t.tokenId}
              onClick={() => onSelect(t.tokenId)}
              className="w-full rounded-none border border-neutral-300 bg-white p-3 flex items-center gap-3 text-left hover:border-black"
            >
              <Avatar image={t.image} symbol={t.symbol} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-sm truncate">{t.symbol}</p>
                <p className="text-[11px] text-neutral-500">{fmtTok(t.myBalance, t.decimals)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold">{fmtXno(valueRaw.toString())} XNO</p>
                <p className={"text-[11px] " + (t.change24h == null ? "text-neutral-400" : t.change24h >= 0 ? "text-black" : "text-black")}>{pctStr(t.change24h)}</p>
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
  { id: "create", label: "Create", icon: "✨" },
  { id: "scan", label: "Explorer", icon: "🔎" },
  { id: "wallet", label: "Wallet", icon: "👛" },
];

function TabBar({ tab, setTab }: { tab: "explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet"; setTab: (t: "explore" | "ranks" | "portfolio" | "create" | "scan" | "wallet") => void }) {
  return (
    <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-neutral-300 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      <div className="w-full grid grid-cols-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={"py-3 text-xs font-bold uppercase tracking-wide border-t-2 " + (tab === t.id ? "text-black border-black" : "text-neutral-400 border-transparent hover:text-black")}
          >
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  );
}