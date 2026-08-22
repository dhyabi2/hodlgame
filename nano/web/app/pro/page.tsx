"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Keys,
  keysFromSeed,
  quoteBuy,
  quoteSell,
  fmtXno,
  fmtTok,
  short,
  pctStr,
  timeAgo,
  execBuy,
  execBuyDirect,
  execSell,
  toRaw,
  sendOp,
  receiveAll,
  fetchXnoBalance,
  fmtNum,
  clampSlippage,
} from "../lib/trade";
import { loadWallet, decryptSeed } from "../lib/wallet";
import { useXnoUsd, fmtUsd } from "../lib/usd";

interface PricePoint { time: number; priceRaw: string; marketCapRaw: string }
interface Trade { kind: "buy" | "sell"; account: string; amountRaw: string; priceRaw: string; time: number }
interface Holder { account: string; balanceRaw: string; pct: number }
interface Token {
  tokenId: string; name: string; symbol: string; decimals: number; image: string;
  creator: string; supply: string; treasury: string;
  poolXno: string; poolTokens: string; price: string; marketCap: string;
  change1h: number | null; change24h: number | null; createdAt: number;
  myBalance: string; myCredit: string; myStaked: string; myClaimable: string; totalStaked: string;
  buyVolume: string; sellVolume: string; holders: number; pool: string | null;
  direct: boolean; myEarmark: string; myFloor: string; myQueueOwed: string; myPrepaid: string;
  totalFloor: string; queueTotal: string; queueHead: { account: string; owedRaw: string } | null; coveragePct: number | null;
  series: PricePoint[]; trades: Trade[]; topHolders: Holder[];
}

const TF = [
  { k: "5m", s: 300 },
  { k: "15m", s: 900 },
  { k: "1h", s: 3600 },
  { k: "4h", s: 14400 },
  { k: "1d", s: 86400 },
] as const;

const priceNum = (raw: string) => Number(BigInt(raw)) / 1e30;
// Fallback identity for a coin whose off-chain metadata hasn't loaded/saved —
// same convention as the main app, so a live coin is never a blank label.
const tokSym = (t: { symbol: string; tokenId: string }) => t.symbol || t.tokenId.slice(0, 4).toUpperCase();

export default function ProPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [token, setToken] = useState<Token | null>(null);
  const [keys, setKeys] = useState<Keys | null>(null);
  const [toast, setToast] = useState<string>("");
  const say = (s: string) => { setToast(s); setTimeout(() => setToast(""), 3500); };

  // initial token from ?token=
  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("token");
      if (t) setTokenId(t.toLowerCase());
    } catch {}
  }, []);

  // token list (for the picker)
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await (await fetch(`/api/state?account=${keys?.address ?? ""}`)).json();
        if (live) {
          // Hide imageless pre-fix test launches from the picker too.
          const list: Token[] = (j.tokens ?? []).filter((t: Token) => t.image || BigInt(t.myBalance || "0") > 0n);
          setTokens(list);
          // Functional update so a ?token= already set (via the other effect)
          // is never clobbered by a stale-closure default to list[0].
          if (list.length) setTokenId((prev) => prev ?? list[0].tokenId);
        }
      } catch {}
    };
    load();
    const t = setInterval(load, 6000);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys?.address]);

  // selected token detail (live)
  useEffect(() => {
    if (!tokenId) return;
    let live = true;
    const load = async () => {
      try {
        const j = await (await fetch(`/api/token?token=${tokenId}&account=${keys?.address ?? ""}`)).json();
        if (!live) return;
        if (j.token) setToken(j.token);
        // Bad/stale ?token= (404 {error}): fall back to the first real token so
        // a shared Pro link never strands the user on the loading skeleton.
        else if (j.error && !token) {
          setTokenId((prev) => (tokens.find((t) => t.tokenId === prev) ? prev : tokens[0]?.tokenId ?? null));
        }
      } catch {}
    };
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [tokenId, keys?.address, tokens]);

  useEffect(() => {
    if (!tokenId) return;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("token", tokenId);
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, [tokenId]);

  return (
    <main className="min-h-screen bg-black text-white" style={{ fontFeatureSettings: '"tnum" 1' }}>
      <TopBar
        tokens={tokens}
        token={token}
        onPick={(id) => { setToken(null); setTokenId(id); }}
        keys={keys}
        setKeys={setKeys}
        say={say}
      />
      {!token ? (
        <div className="w-full p-6">
          <div className="grid grid-cols-12 gap-3">
            <Skeleton className="col-span-12 lg:col-span-8 h-[420px]" />
            <Skeleton className="col-span-12 lg:col-span-4 h-[420px]" />
            <Skeleton className="col-span-12 lg:col-span-4 h-56" />
            <Skeleton className="col-span-12 lg:col-span-4 h-56" />
            <Skeleton className="col-span-12 lg:col-span-4 h-56" />
          </div>
        </div>
      ) : (
        <div className="w-full p-3 sm:p-4">
          <div className="grid grid-cols-12 gap-3">
            <Panel className="col-span-12 lg:col-span-8 min-h-[420px]">
              <ChartPanel token={token} />
            </Panel>
            <Panel className="col-span-12 lg:col-span-4">
              <OrderTicket token={token} keys={keys} say={say} />
            </Panel>
            <Panel className="col-span-12 lg:col-span-4 min-h-[240px]">
              <DepthCurve token={token} />
            </Panel>
            <Panel className="col-span-12 lg:col-span-4 min-h-[240px]">
              <Tape token={token} keys={keys} />
            </Panel>
            <Panel className="col-span-12 lg:col-span-4 min-h-[240px]">
              <HoldersList token={token} />
            </Panel>
          </div>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-none border border-neutral-700 bg-neutral-950 px-4 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={"rounded-none border border-neutral-800 bg-neutral-950 p-3 " + className}>{children}</section>;
}
function Skeleton({ className = "" }: { className?: string }) {
  return <div className={"rounded-none bg-neutral-900 animate-pulse " + className} />;
}

// ── top bar: ticker stats + token picker + wallet ───────────────────────────
function TopBar({
  tokens, token, onPick, keys, setKeys, say,
}: {
  tokens: Token[]; token: Token | null; onPick: (id: string) => void;
  keys: Keys | null; setKeys: (k: Keys | null) => void; say: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ch = token?.change24h ?? null;
  const usd = useXnoUsd();
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800 bg-black/95 backdrop-blur">
      <div className="w-full flex items-center gap-4 px-3 sm:px-4 py-2.5">
        <a href="/" className="text-xs text-neutral-500 hover:text-white shrink-0">← app</a>
        <span className="rounded-none bg-white px-1.5 py-0.5 text-[10px] font-black tracking-[0.2em] text-black">PRO</span>

        <div className="relative">
          <button
            className="flex items-center gap-2 rounded-none border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 hover:border-neutral-500"
            onClick={() => setOpen((v) => !v)}
          >
            {token ? <Avatar image={token.image} symbol={tokSym(token)} size={22} /> : <div className="h-[22px] w-[22px] rounded-full bg-neutral-900" />}
            <span className="text-sm font-black">{token ? tokSym(token) : "…"}</span>
            <span className="text-neutral-500 text-xs">▾</span>
          </button>
          {open && (
            <div className="absolute left-0 top-full mt-1 max-h-80 w-72 overflow-y-auto rounded-none border border-neutral-800 bg-neutral-950 p-1 shadow-2xl">
              {tokens.map((t) => (
                <button
                  key={t.tokenId}
                  className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left hover:bg-neutral-900"
                  onClick={() => { onPick(t.tokenId); setOpen(false); }}
                >
                  <Avatar image={t.image} symbol={tokSym(t)} size={20} />
                  <span className="flex-1 truncate text-sm font-bold">{tokSym(t)}</span>
                  <span className="text-[11px] text-neutral-500">{fmtXno(t.price)}</span>
                  <span className={"text-[11px] w-14 text-right " + chColor(t.change24h)}>{pctStr(t.change24h)}</span>
                </button>
              ))}
              {tokens.length === 0 && <p className="px-2 py-3 text-center text-xs text-neutral-500">no tokens yet</p>}
            </div>
          )}
        </div>

        {token && (
          <div className="hidden sm:flex items-baseline gap-4 text-xs">
            <Stat label="price" value={`${fmtXno(token.price)} XNO${usd != null ? ` (${fmtUsd(token.price, usd)})` : ""}`} />
            <Stat label="24h" value={pctStr(ch)} valueClass={chColor(ch)} />
            <Stat label="mcap" value={`${fmtXno(token.marketCap)}${usd != null ? ` (${fmtUsd(token.marketCap, usd)})` : ""}`} />
            <Stat label="liq" value={`${fmtXno(token.poolXno)}`} />
            <Stat label="holders" value={String(token.holders)} />
          </div>
        )}

        <div className="ml-auto shrink-0">
          <WalletBadge keys={keys} setKeys={setKeys} say={say} />
        </div>
      </div>
    </header>
  );
}
const chColor = (n: number | null) => (n == null ? "text-neutral-500" : n >= 0 ? "text-green-500" : "text-red-500");
function Stat({ label, value, valueClass = "" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wider text-neutral-500">{label}</span>
      <span className={"font-bold tabular-nums " + valueClass}>{value}</span>
    </div>
  );
}

function WalletBadge({ keys, setKeys, say }: { keys: Keys | null; setKeys: (k: Keys | null) => void; say: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const hasWallet = useMemo(() => { try { return Boolean(loadWallet()); } catch { return false; } }, [open]);

  const unlock = async () => {
    setErr("");
    try {
      const w = loadWallet();
      if (!w) return setErr("no wallet — create one in the app");
      const s = await decryptSeed(w, pw);
      if (!/^[0-9a-fA-F]{64}$/.test(s)) return setErr("wrong password");
      const k = keysFromSeed(s);
      setKeys(k);
      setOpen(false);
      setPw("");
      say("wallet unlocked");
      receiveAll(k).then((r) => { if (r.count) say(`received ${r.count} pending ✓`); }).catch(() => {});
    } catch { setErr("wrong password"); }
  };

  if (keys) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden md:inline font-mono text-[11px] text-neutral-400">{short(keys.address)}</span>
        <button className="rounded-none border border-neutral-800 px-2.5 py-1.5 text-[11px] font-bold hover:border-white" onClick={() => setKeys(null)}>Lock</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <button className="rounded-none bg-white px-3 py-1.5 text-[11px] font-black text-black hover:bg-neutral-200" onClick={() => setOpen((v) => !v)}>
        Connect
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-none border border-neutral-800 bg-neutral-950 p-3 shadow-2xl space-y-2">
          {hasWallet ? (
            <>
              <p className="text-[11px] text-neutral-400">Unlock your wallet</p>
              <input className={inp} type="password" placeholder="password" value={pw}
                onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlock()} autoFocus />
              {err && <p className="text-[11px] text-white">{err}</p>}
              <button className={btnGreen} onClick={unlock}>Unlock</button>
            </>
          ) : (
            <p className="text-[11px] text-neutral-500">No wallet on this browser. Create or import one in the <a href="/" className="text-white underline">main app</a>, then come back.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── candlestick chart ───────────────────────────────────────────────────────
function ChartPanel({ token }: { token: Token }) {
  const [tf, setTf] = useState(0); // default 5m
  const candles = useMemo(() => buildCandles(token.series, TF[tf].s), [token.series, tf]);
  const vol = useMemo(() => buildVolume(token.trades, TF[tf].s, token.decimals), [token.trades, tf, token.decimals]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-neutral-300">{tokSym(token)}/XNO</span>
          <span className="text-xs text-neutral-500">{fmtXno(token.price)} XNO</span>
          <span className={"text-xs " + chColor(token.change24h)}>{pctStr(token.change24h)}</span>
        </div>
        <div className="flex gap-1">
          {TF.map((t, i) => (
            <button key={t.k}
              className={"rounded-none px-2 py-0.5 text-[11px] font-bold " + (i === tf ? "bg-white text-black" : "text-neutral-500 hover:text-white")}
              onClick={() => setTf(i)}>{t.k}</button>
          ))}
        </div>
      </div>
      {candles.length >= 2 ? (
        <CandleCanvas candles={candles} vol={vol} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">not enough trades yet to chart — first buy prints the first candle</div>
      )}
    </div>
  );
}

interface Candle { t: number; o: number; h: number; l: number; c: number }
function buildCandles(series: PricePoint[], tf: number): Candle[] {
  if (!series.length) return [];
  const byBucket = new Map<number, Candle>();
  for (const p of series) {
    const price = priceNum(p.priceRaw);
    if (!Number.isFinite(price)) continue;
    const bucket = Math.floor(p.time / tf) * tf;
    const existing = byBucket.get(bucket);
    if (!existing) byBucket.set(bucket, { t: bucket, o: price, h: price, l: price, c: price });
    else { existing.h = Math.max(existing.h, price); existing.l = Math.min(existing.l, price); existing.c = price; }
  }
  return Array.from(byBucket.values()).sort((a, b) => a.t - b.t).slice(-120);
}
function buildVolume(trades: Trade[], tf: number, dec: number): Map<number, { buy: number; sell: number }> {
  const m = new Map<number, { buy: number; sell: number }>();
  for (const tr of trades) {
    const bucket = Math.floor(tr.time / tf) * tf;
    const xno = (Number(BigInt(tr.amountRaw)) / 10 ** dec) * priceNum(tr.priceRaw);
    const e = m.get(bucket) ?? { buy: 0, sell: 0 };
    if (tr.kind === "buy") e.buy += xno; else e.sell += xno;
    m.set(bucket, e);
  }
  return m;
}

function CandleCanvas({ candles, vol }: { candles: Candle[]; vol: Map<number, { buy: number; sell: number }> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 340 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = dims;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padR = 58, padL = 6, padT = 8;
    const volH = 42, gap = 8;
    const priceH = h - volH - gap - padT;
    const plotW = w - padR - padL;

    let hi = -Infinity, lo = Infinity;
    for (const c of candles) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); }
    if (!(hi > lo)) { hi = hi || 1; lo = lo * 0.99 || 0; }
    const range = hi - lo || 1;
    const pad = range * 0.08;
    hi += pad; lo = Math.max(0, lo - pad);
    const yOf = (p: number) => padT + priceH - ((p - lo) / (hi - lo)) * priceH;

    // grid + price axis labels
    ctx.strokeStyle = "#262626"; ctx.fillStyle = "#737373";
    ctx.font = "10px ui-monospace, monospace"; ctx.lineWidth = 1;
    const rows = 4;
    for (let i = 0; i <= rows; i++) {
      const p = lo + ((hi - lo) * i) / rows;
      const y = yOf(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(fmtAxis(p), padL + plotW + 4, y + 3);
    }

    const n = candles.length;
    const cw = plotW / n;
    const bodyW = Math.max(1, Math.min(cw * 0.66, 14));
    let vMax = 0;
    for (const c of candles) { const v = vol.get(c.t); if (v) vMax = Math.max(vMax, v.buy + v.sell); }
    const volTop = h - volH;

    candles.forEach((c, i) => {
      const x = padL + i * cw + cw / 2;
      const up = c.c >= c.o;
      const col = up ? "#22c55e" : "#ef4444";
      // wick
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
      // body
      const yO = yOf(c.o), yC = yOf(c.c);
      const top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = col;
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      // volume bar
      const v = vol.get(c.t);
      if (v && vMax > 0) {
        const vv = (v.buy + v.sell) / vMax;
        const bh2 = vv * (volH - 4);
        ctx.fillStyle = v.buy >= v.sell ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)";
        ctx.fillRect(x - bodyW / 2, h - bh2, bodyW, bh2);
      }
    });

    // last price line
    const last = candles[n - 1];
    const ly = yOf(last.c);
    ctx.strokeStyle = last.c >= last.o ? "#22c55e" : "#ef4444";
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + plotW, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = last.c >= last.o ? "#22c55e" : "#ef4444";
    ctx.fillRect(padL + plotW + 1, ly - 7, padR - 2, 14);
    ctx.fillStyle = "#fff"; ctx.font = "9px ui-monospace, monospace";
    ctx.fillText(fmtAxis(last.c), padL + plotW + 4, ly + 3);

    // volume divider label
    ctx.fillStyle = "#737373"; ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("vol", padL + 2, volTop + 10);
  }, [candles, vol, dims]);

  return (
    <div ref={wrapRef} className="relative flex-1" style={{ minHeight: 340 }}>
      <canvas ref={ref} />
    </div>
  );
}
function fmtAxis(p: number): string {
  return fmtNum(p, 3);
}

// ── order ticket ────────────────────────────────────────────────────────────
function OrderTicket({ token, keys, say }: { token: Token; keys: Keys | null; say: (s: string) => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [busy, setBusy] = useState(false);
  const [xnoBal, setXnoBal] = useState("0");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!keys) { setXnoBal("0"); return; }
    let live = true;
    const load = () => fetchXnoBalance(keys.address).then((b) => live && setXnoBal(b));
    load();
    const t = setInterval(load, 8000);
    return () => { live = false; clearInterval(t); };
  }, [keys?.address, busy]);

  // hotkeys: B/S switch side, Enter confirm
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (!typing && (e.key === "b" || e.key === "B")) { setSide("buy"); inputRef.current?.focus(); }
      if (!typing && (e.key === "s" || e.key === "S")) { setSide("sell"); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const slip = clampSlippage(slippage); // NaN→0, clamped [0,100]; non-numeric input no longer crashes the quote
  const quote = useMemo(() => {
    const px = BigInt(token.poolXno), pt = BigInt(token.poolTokens);
    if (px <= 0n || pt <= 0n) return null;
    const n = Number(amount || "0");
    if (!Number.isFinite(n) || n <= 0) return null;
    if (side === "buy") {
      const raw = BigInt(Math.floor(n * 1e30)); if (raw <= 0n) return null;
      const out = quoteBuy(token.poolXno, token.poolTokens, raw); if (out <= 0n) return null;
      const ideal = (raw * pt) / px;
      const impact = ideal > 0n ? Math.max(0, Number((ideal - out) * 10000n / ideal) / 100) : 0;
      const min = (out * BigInt(Math.round((100 - slip) * 100))) / 10000n;
      return { out: fmtTok(out.toString(), token.decimals), unit: tokSym(token), min: fmtTok(min.toString(), token.decimals), impact };
    }
    const raw = BigInt(Math.floor(n * 10 ** token.decimals)); if (raw <= 0n) return null;
    const out = quoteSell(token.poolXno, token.poolTokens, raw); if (out <= 0n) return null;
    const ideal = (raw * px) / pt;
    const impact = ideal > 0n ? Math.max(0, Number((ideal - out) * 10000n / ideal) / 100) : 0;
    const min = (out * BigInt(Math.round((100 - slip) * 100))) / 10000n;
    return { out: fmtXno(out.toString()), unit: "XNO", min: fmtXno(min.toString()), impact };
  }, [amount, side, slip, token.poolXno, token.poolTokens, token.decimals, token.symbol]);

  const setPct = (p: number) => {
    if (side === "buy") {
      const bal = Number(BigInt(xnoBal)) / 1e30;
      const usable = Math.max(0, bal - 0.0001); // leave dust for the op block
      setAmount(String(+(usable * p).toFixed(6)));
    } else {
      const bal = Number(BigInt(token.myBalance || "0")) / 10 ** token.decimals;
      setAmount(String(+(bal * p).toFixed(6)));
    }
  };

  const confirm = async () => {
    if (!keys) return say("connect a wallet first");
    if (!quote) return say("enter an amount");
    setBusy(true);
    try {
      if (side === "buy") {
        const h = token.direct
          ? await execBuyDirect(keys, token, amount, slip)
          : await execBuy(keys, token, amount, slip);
        say(`bought ✓ ${h.slice(0, 10)}…`);
      } else {
        const h = await execSell(keys, token, amount, slip); // direct sells settle at sell (state.ts nets wallet-side)
        say(token.direct
          ? "sold ✓ — principal settled instantly from your collateral; any profit is queued for the next buys"
          : "sold ✓ — XNO credited to your game balance. Withdraw any time.");
      }
      setAmount("");
    } catch (e: any) {
      say(`${side} failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  };

  // Direct (zero-custody) tokens have NO pool account by design — tradeability
  // is purely "virtual reserves seeded", never a pool address existing.
  const noPool = token.direct ? BigInt(token.poolXno) <= 0n : !token.pool || BigInt(token.poolXno) <= 0n;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 rounded-none bg-neutral-950 p-1">
        <button className={"rounded-none py-2 text-sm font-black " + (side === "buy" ? "bg-white text-black" : "text-neutral-500 hover:text-white")} onClick={() => setSide("buy")}>Buy</button>
        <button className={"rounded-none py-2 text-sm font-black " + (side === "sell" ? "bg-white text-black" : "text-neutral-500 hover:text-white")} onClick={() => setSide("sell")}>Sell</button>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
          <span>{side === "buy" ? "you pay (XNO)" : `you sell (${tokSym(token)})`}</span>
          <span>bal {side === "buy" ? fmtXno(xnoBal) : fmtTok(token.myBalance, token.decimals)}</span>
        </div>
        <input
          ref={inputRef}
          className={inp}
          placeholder="0.0"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && confirm()}
        />
        <div className="mt-2 grid grid-cols-4 gap-1">
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <button key={p} className="rounded-none border border-neutral-800 py-1 text-[11px] font-bold text-neutral-400 hover:border-neutral-500 hover:text-neutral-200" onClick={() => setPct(p)}>
              {p === 1 ? "MAX" : `${p * 100}%`}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center justify-between text-[11px] text-neutral-500">
        <span>slippage tolerance</span>
        <span className="flex items-center gap-1">
          <input className="w-14 rounded-none border border-neutral-800 bg-neutral-950 px-2 py-1 text-right text-xs text-white" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
          <span>%</span>
        </span>
      </label>

      <div className="rounded-none border border-neutral-800 bg-neutral-950 p-2.5 text-[11px] space-y-1">
        <Row2 l="you receive ≈" r={quote ? `${quote.out} ${quote.unit}` : "—"} rClass="font-bold text-white" />
        <Row2 l={`min @ ${slip}%`} r={quote ? `${quote.min} ${quote.unit}` : "—"} />
        <Row2 l="price impact" r={quote ? `${quote.impact.toFixed(2)}%` : "—"} rClass={quote ? (quote.impact >= 5 ? "text-white" : quote.impact >= 1 ? "text-white" : "text-white") : ""} />
      </div>

      <button
        className={"rounded-none py-3 text-sm font-black disabled:opacity-40 " + (side === "buy" ? "bg-white text-black hover:bg-neutral-200" : "bg-white text-black hover:bg-neutral-200")}
        disabled={busy || noPool}
        onClick={confirm}
      >
        {noPool ? "no liquidity yet" : busy ? "submitting…" : side === "buy" ? `Buy ${tokSym(token)}` : `Sell ${tokSym(token)}`}
      </button>
      <p className="text-center text-[10px] text-neutral-500">hotkeys: <kbd className="text-neutral-400">B</kbd> buy · <kbd className="text-neutral-400">S</kbd> sell · <kbd className="text-neutral-400">Enter</kbd> confirm</p>

      <PositionCard token={token} keys={keys} busy={busy} setBusy={setBusy} say={say} />
    </div>
  );
}
function Row2({ l, r, rClass = "" }: { l: string; r: string; rClass?: string }) {
  return <div className="flex justify-between"><span className="text-neutral-500">{l}</span><span className={"tabular-nums " + rClass}>{r}</span></div>;
}

function PositionCard({ token, keys, busy, setBusy, say }: { token: Token; keys: Keys | null; busy: boolean; setBusy: (b: boolean) => void; say: (s: string) => void }) {
  const [stakeAmt, setStakeAmt] = useState("");
  const [unstakeAmt, setUnstakeAmt] = useState("");
  const bal = BigInt(token.myBalance || "0");
  const staked = BigInt(token.myStaked || "0");
  const claimable = BigInt(token.myClaimable || "0");
  const valueRaw = (bal * BigInt(token.price)) / 10n ** BigInt(token.decimals);

  const run = async (fn: () => Promise<string>, label: string) => {
    if (!keys) return say("connect first");
    setBusy(true);
    try { const h = await fn(); say(`${label} ✓ ${h.slice(0, 10)}…`); }
    catch (e: any) { say(`${label} failed: ${e?.message ?? e}`); }
    finally { setBusy(false); }
  };
  const doStake = () => {
    const raw = toRaw(stakeAmt, token.decimals);
    if (raw <= 0n || !keys) return;
    run(() => sendOp(keys, token.tokenId, { kind: "stake", amount: raw }), "stake").then(() => setStakeAmt(""));
  };
  const doUnstake = () => {
    const raw = toRaw(unstakeAmt, token.decimals);
    if (raw <= 0n || !keys) return;
    run(() => sendOp(keys, token.tokenId, { kind: "unstake", amount: raw }), "unstake").then(() => setUnstakeAmt(""));
  };

  return (
    <div className="mt-auto rounded-none border border-neutral-800 bg-neutral-950 p-2.5 space-y-2">
      <p className="text-[11px] font-bold text-neutral-400">Your position</p>
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <Row2 l="holding" r={`${fmtTok(token.myBalance, token.decimals)}`} />
        <Row2 l="value" r={`${fmtXno(valueRaw.toString())} XNO`} />
        <Row2 l="staked" r={`${fmtTok(token.myStaked, token.decimals)}`} />
        <Row2 l="claimable" r={`${fmtXno(token.myClaimable)} XNO`} rClass="text-white" />
        {token.direct ? (
          <>
            <Row2 l="collateral" r={`${fmtXno(token.myEarmark)} XNO`} />
            <Row2 l="in payout line" r={`${fmtXno(token.myQueueOwed)} XNO`} rClass="text-white" />
          </>
        ) : (
          <Row2 l="game balance" r={`${fmtXno(token.myCredit)} XNO`} />
        )}
      </div>
      <div className="flex gap-1">
        <input className={inpSm} placeholder="stake" inputMode="decimal" value={stakeAmt} onChange={(e) => setStakeAmt(e.target.value)} />
        {[25, 50, 100].map((p) => (
          <button key={p} className="shrink-0 rounded-none border border-neutral-800 px-1.5 text-[10px] font-bold text-neutral-400 hover:border-white" disabled={bal <= 0n}
            onClick={() => setStakeAmt(fmtTok(((bal * BigInt(p)) / 100n).toString(), token.decimals))}>{p === 100 ? "MAX" : `${p}%`}</button>
        ))}
        <button className={miniBtn} disabled={busy || bal <= 0n} onClick={doStake}>Stake</button>
      </div>
      <div className="flex gap-1">
        <input className={inpSm} placeholder="unstake" inputMode="decimal" value={unstakeAmt} onChange={(e) => setUnstakeAmt(e.target.value)} />
        {[25, 50, 100].map((p) => (
          <button key={p} className="shrink-0 rounded-none border border-neutral-800 px-1.5 text-[10px] font-bold text-neutral-400 hover:border-white" disabled={staked <= 0n}
            onClick={() => setUnstakeAmt(fmtTok(((staked * BigInt(p)) / 100n).toString(), token.decimals))}>{p === 100 ? "MAX" : `${p}%`}</button>
        ))}
        <button className={miniBtn} disabled={busy || staked <= 0n} onClick={doUnstake}>Unstake</button>
      </div>
      <button
        className="w-full rounded-none bg-neutral-900 border border-neutral-600 py-1.5 text-[11px] font-bold text-white hover:bg-neutral-800 disabled:opacity-40"
        disabled={busy || claimable <= 0n || !keys}
        onClick={() => keys && run(() => sendOp(keys, token.tokenId, { kind: "claim" }), "claim")}
      >
        Claim {fmtXno(token.myClaimable)} XNO
      </button>
      <button
        className="w-full rounded-none bg-white py-1.5 text-[11px] font-black uppercase text-black hover:bg-neutral-200 disabled:opacity-40"
        disabled={busy || BigInt(token.myCredit || "0") <= 0n || !keys}
        onClick={() => keys && run(() => sendOp(keys, token.tokenId, { kind: "withdraw" }), "withdraw")}
      >
        Withdraw {fmtXno(token.myCredit)} XNO
      </button>
    </div>
  );
}

// ── AMM depth curve ─────────────────────────────────────────────────────────
function DepthCurve({ token }: { token: Token }) {
  const px = Number(BigInt(token.poolXno)) / 1e30;
  const pt = Number(BigInt(token.poolTokens)) / 10 ** token.decimals;
  const k = px * pt;
  const spot = pt > 0 ? px / pt : 0;

  const pts = useMemo(() => {
    if (!(k > 0) || !(pt > 0)) return { buy: [] as [number, number][], sell: [] as [number, number][] };
    // sweep pool-token reserve from -40%..+40% and price = k / tok^2 wrt reserve
    const buy: [number, number][] = [];
    const sell: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      // buy side: tokens leave the pool → reserve shrinks → price rises
      const tb = pt * (1 - f * 0.4);
      buy.push([1 - tb / pt, (k / (tb * tb))]);
      // sell side: tokens enter → reserve grows → price falls
      const ts = pt * (1 + f * 0.4);
      sell.push([ts / pt - 1, (k / (ts * ts))]);
    }
    return { buy, sell };
  }, [k, pt]);

  const W = 300, H = 150, padL = 6, padR = 6, padT = 8, padB = 18;
  const all = [...pts.buy, ...pts.sell];
  const maxP = Math.max(spot, ...all.map((p) => p[1]), 1e-30);
  const minP = Math.min(spot, ...all.map((p) => p[1]));
  const maxX = 0.4;
  const xOf = (dx: number) => padL + (W - padL - padR) * (0.5 + (dx / maxX) * 0.5 * (1));
  const yOf = (p: number) => padT + (H - padT - padB) * (1 - (p - minP) / (maxP - minP || 1));

  const path = (arr: [number, number][], dir: 1 | -1) =>
    arr.map((p, i) => `${i ? "L" : "M"} ${(padL + (W - padL - padR) * (0.5 + dir * (p[0] / maxX) * 0.5)).toFixed(1)} ${yOf(p[1]).toFixed(1)}`).join(" ");

  if (!(k > 0)) return <Empty label="No liquidity yet — the AMM curve appears after the first seed." />;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-bold text-neutral-300">AMM depth</p>
        <p className="text-[11px] text-neutral-500">k = {fmtCompact(k)}</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full flex-1" preserveAspectRatio="none">
        <line x1={W / 2} y1={padT} x2={W / 2} y2={H - padB} stroke="#404040" strokeDasharray="2 2" />
        <line x1={padL} y1={yOf(spot)} x2={W - padR} y2={yOf(spot)} stroke="#737373" strokeWidth="0.5" />
        <path d={path(pts.sell, -1)} fill="none" stroke="#737373" strokeWidth="1.5" />
        <path d={path(pts.buy, 1)} fill="none" stroke="#ffffff" strokeWidth="1.5" />
        <circle cx={W / 2} cy={yOf(spot)} r="2.5" fill="#ffffff" />
        <text x={padL} y={H - 6} fontSize="8" fill="#737373">← sell (price falls)</text>
        <text x={W - padR} y={H - 6} fontSize="8" fill="#737373" textAnchor="end">buy (price rises) →</text>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-neutral-500">
        <span>reserve XNO {fmtCompact(px)}</span>
        <span className="text-right">reserve {tokSym(token)} {fmtCompact(pt)}</span>
      </div>
    </div>
  );
}

// ── live trades tape ────────────────────────────────────────────────────────
function Tape({ token, keys }: { token: Token; keys: Keys | null }) {
  const trades = [...token.trades].reverse();
  const usd = useXnoUsd();
  const tradeXno = (t: Trade) => ((BigInt(t.amountRaw) * BigInt(t.priceRaw)) / 10n ** BigInt(token.decimals)).toString();
  return (
    <div className="flex h-full flex-col">
      <p className="mb-2 text-sm font-bold text-neutral-300">Trades</p>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[10px] uppercase tracking-wider text-neutral-500 pb-1 border-b border-neutral-800">
        <span>price (XNO)</span><span className="text-right">size</span><span className="text-right">value</span><span className="text-right">age</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {trades.length === 0 && <p className="py-6 text-center text-xs text-neutral-500">no trades yet</p>}
        {trades.slice(0, 60).map((t, i) => {
          const mine = keys && t.account === keys.address;
          return (
            <div key={i} className={"grid grid-cols-[1fr_auto_auto_auto] gap-x-2 py-0.5 text-[11px] tabular-nums " + (mine ? "bg-neutral-900 rounded" : "")}>
              <span className={t.kind === "buy" ? "text-green-500" : "text-red-500"}>{fmtXno(t.priceRaw)}</span>
              <span className="text-right text-neutral-400">{fmtTok(t.amountRaw, token.decimals)}</span>
              <span className="text-right text-neutral-500">{usd != null ? fmtUsd(tradeXno(t), usd) : fmtXno(tradeXno(t))}</span>
              <span className="text-right text-neutral-500">{timeAgo(t.time)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── holders ─────────────────────────────────────────────────────────────────
function HoldersList({ token }: { token: Token }) {
  const top = token.topHolders.slice(0, 12);
  const top10 = token.topHolders.slice(0, 10).reduce((a, h) => a + h.pct, 0);
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-bold text-neutral-300">Holders <span className="text-neutral-500">({token.holders})</span></p>
        <p className="text-[11px] text-neutral-500">top10 <span className={top10 > 80 ? "text-white" : top10 > 50 ? "text-white" : "text-white"}>{top10.toFixed(1)}%</span></p>
      </div>
      <div className="flex-1 overflow-y-auto space-y-1">
        {top.map((h, i) => (
          <div key={h.account} className="flex items-center gap-2 text-[11px]">
            <span className="w-4 text-neutral-500">{i + 1}</span>
            <span className="font-mono text-neutral-400 flex-1 truncate">{h.account === token.creator ? "dev · " : ""}{short(h.account)}</span>
            <div className="h-1.5 w-16 rounded-full bg-neutral-900 overflow-hidden">
              <div className="h-full bg-white" style={{ width: `${Math.min(100, h.pct)}%` }} />
            </div>
            <span className="w-10 text-right tabular-nums text-neutral-400">{h.pct.toFixed(1)}%</span>
          </div>
        ))}
        {top.length === 0 && <p className="py-6 text-center text-xs text-neutral-500">no holders yet</p>}
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center p-4 text-center text-xs text-neutral-500">{label}</div>;
}
// Uploaded images are served by our own /api/image/<id> route. Older uploads
// stored an ABSOLUTE URL baked in with whatever domain/alias was live at
// upload time; if that domain later starts redirecting itself (a *.vercel.app
// alias, a moved custom domain), the old absolute URL breaks forever.
// Normalizing to the CURRENT origin's relative path fixes it regardless of
// which domain view the page loaded from.
function normalizeImage(url: string): string {
  const m = url.match(/^(?:https?:\/\/[^/]+)?\/api\/image\/([0-9a-f]{32})$/);
  return m ? `/api/image/${m[1]}` : url;
}

function Avatar({ image, symbol, size }: { image: string; symbol: string; size: number }) {
  if (image) return <img src={normalizeImage(image)} alt={symbol} width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <div className="flex items-center justify-center rounded-full bg-neutral-800 font-black text-white"
      style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {(symbol || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}
function fmtCompact(n: number): string {
  return fmtNum(n, 3);
}

const inp = "w-full rounded-none border border-neutral-800 bg-black px-3 py-2.5 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white";
const inpSm = "w-full rounded-none border border-neutral-800 bg-black px-2 py-1.5 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-white";
const btnGreen = "w-full rounded-none bg-white px-3 py-2 text-sm font-black text-black hover:bg-neutral-200";
const miniBtn = "shrink-0 rounded-none border border-neutral-800 px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-white disabled:opacity-40";
