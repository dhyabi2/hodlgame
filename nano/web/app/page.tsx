"use client";

import { useEffect, useState, type ReactNode } from "react";
import * as nanocurrency from "nanocurrency";
import dynamic from "next/dynamic";
import { encodeOpLink } from "../../core/oplink";
import { tokenIdFromLaunchHash } from "../../core/token";
import { stringify } from "../../core/json";
import type { Op } from "../../core/ops";
import { Sparkline } from "./components/Sparkline";
import { loadWallet, saveWallet, removeWallet, encryptSeed, decryptSeed } from "./lib/wallet";

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

async function registerCommit(tokenId: string, op: Op): Promise<string> {
  const res = await fetch("/api/commits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stringify({ tokenId, op }),
  });
  const j = await res.json();
  if (!j.link) throw new Error(j.error ?? "commit registration failed");
  return j.link as string;
}

const inputC =
  "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-green-500";
const btn =
  "w-full rounded-xl bg-green-500 px-4 py-3 text-sm font-bold text-black hover:bg-green-400 disabled:opacity-40 transition";

export default function Home() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Token | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const say = (s: string) => setLog((l) => [...l.slice(-9), s]);

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
  }, []);

  // Feed (SSE with polling fallback).
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const j = await (await fetch("/api/state")).json();
        setTokens(j.tokens ?? []);
      } catch {}
    };
    load();
    try {
      es = new EventSource("/api/stream");
      es.onmessage = (e) => {
        const j = JSON.parse(e.data);
        if (j.tokens) setTokens(j.tokens);
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!poll) poll = setInterval(load, 6000);
      };
    } catch {
      if (!poll) poll = setInterval(load, 6000);
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  // Detail (SSE with polling fallback).
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const j = await (await fetch(`/api/token?token=${selectedId}`)).json();
        if (j.token) setDetail(j.token);
      } catch {}
    };
    load();
    try {
      es = new EventSource(`/api/stream?token=${selectedId}`);
      es.onmessage = (e) => {
        const j = JSON.parse(e.data);
        if (j.token) setDetail(j.token);
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!poll) poll = setInterval(load, 4000);
      };
    } catch {
      if (!poll) poll = setInterval(load, 4000);
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [selectedId]);

  async function submitBlock(link: string, balanceDelta: bigint): Promise<string> {
    if (!keys) throw new Error("connect first");
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
    if (!keys) return say("connect first");
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
    <main className="min-h-screen bg-[#050505] text-white">
      <header className="border-b border-zinc-900 px-6 py-4 flex items-center justify-between sticky top-0 bg-[#050505]/90 backdrop-blur z-10">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎉</span>
          <span className="text-xl font-black tracking-tight bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">
            HoldFun
          </span>
          <span className="text-[11px] text-zinc-500 ml-1">Nano</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-xl bg-green-500 px-3 py-2 text-xs font-bold text-black hover:bg-green-400"
            onClick={() => setShowCreate(true)}
          >
            + Start a new coin
          </button>
          {keys ? (
            <button
              className="text-xs text-zinc-400 font-mono truncate max-w-[180px] hover:text-zinc-200"
              title="copy address"
              onClick={() => {
                navigator.clipboard?.writeText(keys.address);
                say(`copied ${short(keys.address)}`);
              }}
            >
              {short(keys.address)}
            </button>
          ) : (
            <span className="text-xs text-zinc-500">wallet locked</span>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <WalletPanel keys={keys} hasWallet={hasWallet} unlock={unlock} lock={lock} remove={remove} />

        {detail ? (
          <TokenDetail
            token={detail}
            keys={keys}
            busy={busy}
            say={say}
            submitBlock={submitBlock}
            sendOp={sendOp}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <Feed tokens={tokens} onSelect={(id) => setSelectedId(id)} myAddress={keys?.address} />
        )}

        {log.length > 0 && (
          <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 text-xs space-y-1">
            {log.map((l, i) => (
              <p key={i} className="text-zinc-400">{l}</p>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateToken
          busy={busy}
          setBusy={setBusy}
          say={say}
          keys={keys}
          submitBlock={submitBlock}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            setSelectedId(id);
          }}
        />
      )}
    </main>
  );
}

function WalletPanel({
  keys,
  hasWallet,
  unlock,
  lock,
  remove,
}: {
  keys: Keys | null;
  hasWallet: boolean;
  unlock: (k: Keys) => void;
  lock: () => void;
  remove: () => void;
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
    return (
      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 flex items-center gap-3">
        <span className="text-sm font-mono text-zinc-300 truncate flex-1">{keys.address}</span>
        <button className="rounded-xl border border-zinc-800 px-4 py-3 text-sm font-bold text-zinc-200 hover:border-red-500 shrink-0" onClick={lock}>
          Lock
        </button>
      </div>
    );
  }

  if (hasWallet) {
    return (
      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 space-y-2">
        <p className="text-sm font-bold text-zinc-300">Open wallet</p>
        <input className={inputC} type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button className={btn} disabled={busy} onClick={open}>
            {busy ? "opening…" : "Open"}
          </button>
          <button className="rounded-xl border border-zinc-800 px-4 py-3 text-sm font-bold text-red-400 hover:border-red-500" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 space-y-2">
      <div className="flex gap-2">
        <button className={"px-4 py-2 rounded-xl text-sm font-bold " + (mode === "create" ? "bg-zinc-800 text-white" : "text-zinc-500")} onClick={() => setMode("create")}>
          Create
        </button>
        <button className={"px-4 py-2 rounded-xl text-sm font-bold " + (mode === "import" ? "bg-zinc-800 text-white" : "text-zinc-500")} onClick={() => setMode("import")}>
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
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button className={btn} disabled={busy} onClick={mode === "create" ? create : importSeed}>
        {busy ? "encrypting…" : mode === "create" ? "Create wallet" : "Encrypt & unlock"}
      </button>
      <p className="text-[11px] text-zinc-600">seed is encrypted in your browser (PBKDF2 + AES-GCM) and never leaves it</p>
    </div>
  );
}

function Feed({ tokens, onSelect, myAddress }: { tokens: Token[]; onSelect: (id: string) => void; myAddress?: string }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"mc" | "price" | "change" | "vol" | "new">("mc");

  const filtered = tokens
    .filter((t) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q);
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
      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-10 text-center text-zinc-500">
        <p className="text-4xl mb-3">🚀</p>
        <p className="font-bold text-zinc-300">No coins yet</p>
        <p className="text-sm mt-1">Start a new coin to launch the first one on Nano.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold text-zinc-400 shrink-0">Coins</h2>
        <input
          className={inputC + " py-2"}
          placeholder="search name / symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 shrink-0"
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
      {filtered.length === 0 && <p className="text-sm text-zinc-600 py-6 text-center">No coins match.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((t) => (
          <button
            key={t.tokenId}
            onClick={() => onSelect(t.tokenId)}
            className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 text-left hover:border-green-500/60 transition group"
          >
            <div className="flex items-center gap-3">
              <Avatar image={t.image} symbol={t.symbol} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="font-bold text-sm truncate">{t.name}</p>
                  <p className="text-[11px] text-zinc-500">${t.symbol}</p>
                </div>
                <p className="text-[11px] text-zinc-500">mc {fmtXno(t.marketCap)} XNO</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Sparkline points={t.spark} width={80} height={28} color={trendColor(t.spark)} />
                <p className="text-[11px] text-zinc-400">{fmtXno(t.price)} XNO</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
              <span className={"font-bold " + (t.change24h == null ? "text-zinc-600" : t.change24h >= 0 ? "text-green-400" : "text-red-400")}>
                {pctStr(t.change24h)} 24h
              </span>
              <span>{t.holders} holders</span>
              <span>vol {fmtXno(t.buyVolume)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function trendColor(points: PricePoint[]): string {
  if (points.length < 2) return "#22c55e";
  const a = BigInt(points[0].priceRaw);
  const b = BigInt(points[points.length - 1].priceRaw);
  return b >= a ? "#22c55e" : "#ef4444";
}

function Avatar({ image, symbol, size = 40 }: { image: string; symbol: string; size?: number }) {
  if (image) {
    return <img src={image} alt="" style={{ width: size, height: size }} className="rounded-full object-cover shrink-0" />;
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="rounded-full bg-gradient-to-br from-green-400 to-emerald-600 flex items-center justify-center font-black text-black shrink-0"
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
  onBack,
}: {
  token: Token;
  keys: Keys | null;
  busy: boolean;
  say: (s: string) => void;
  submitBlock: (link: string, delta: bigint) => Promise<string>;
  sendOp: (tokenId: string, op: Op, label: string) => Promise<void>;
  onBack: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [tab, setTab] = useState<"trade" | "thread">("trade");
  const [slippage, setSlippage] = useState("0");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");

  const myHolding = keys ? token.topHolders.find((h) => h.account === keys.address) : undefined;

  async function buy() {
    if (!keys || !token.pool) return say("connect + a token with a pool");
    const raw = BigInt(Math.floor(Number(amount || "0") * 1e30)) || 0n;
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
      const slip = Number(slippage || "0");
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
    const raw = BigInt(Math.floor(Number(amount || "0") * 10 ** token.decimals)) || 0n;
    if (raw <= 0n) return say("enter token amount");
    setAmount("");
    const slip = Number(slippage || "0");
    try {
      if (slip > 0) {
        const expected = quoteSell(token.poolXno, token.poolTokens, raw);
        const minXno = (expected * BigInt(Math.round((100 - slip) * 100))) / 10000n;
        const link = await registerCommit(token.tokenId, { kind: "sell", tokens: raw, minXno });
        await submitBlock(link, 1n);
        say("sell ✓");
      } else {
        await sendOp(token.tokenId, { kind: "sell", tokens: raw, minXno: 0n }, "sell");
      }
    } catch (e: any) {
      say("sell failed: " + e.message);
    }
  }

  async function transfer() {
    const to = sendTo.trim();
    const raw = BigInt(Math.floor(Number(sendAmount || "0") * 10 ** token.decimals)) || 0n;
    if (!to || raw <= 0n) return say("enter recipient address + amount");
    if (!to.startsWith("nano_")) return say("recipient must be a nano_ address");
    try {
      const link = await registerCommit(token.tokenId, { kind: "transfer", to, amount: raw });
      const hash = await submitBlock(link, 1n);
      say(`sent ✓ ${hash.slice(0, 10)}…`);
      setSendAmount("");
      setSendTo("");
    } catch (e: any) {
      say("send failed: " + e.message);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-300">← all coins</button>

      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-5">
        <div className="flex items-center gap-3">
          <Avatar image={token.image} symbol={token.symbol} size={48} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-black truncate">{token.name}</h2>
              <span className="text-[11px] text-zinc-500">${token.symbol}</span>
            </div>
            <p className="text-[11px] text-zinc-600 font-mono truncate">{token.tokenId}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-black">{fmtXno(token.marketCap)} XNO</p>
            <p className="text-[11px] text-zinc-500">
              market cap · <span className={token.change24h == null ? "text-zinc-600" : token.change24h >= 0 ? "text-green-400" : "text-red-400"}>{pctStr(token.change24h)}</span>
            </p>
          </div>
        </div>
        {token.description && <p className="text-sm text-zinc-400 mt-3">{token.description}</p>}
        <div className="flex gap-3 mt-3">
          {token.website && <SocialLink href={token.website} label="website" />}
          {token.twitter && <SocialLink href={token.twitter} label="X" />}
          {token.telegram && <SocialLink href={token.telegram} label="telegram" />}
        </div>
        <div className="flex items-center gap-3 mt-4 text-[11px] text-zinc-500">
          <span>dev {short(token.creator)}</span>
          <span>holders {token.holders}</span>
          <span>price {fmtXno(token.price)} XNO</span>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold text-zinc-300">Price</p>
          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
            <span>liq {fmtXno(token.poolXno)} XNO</span>
            <span>reserve {fmtTok(token.poolTokens, token.decimals)}</span>
          </div>
        </div>
        {token.series.length >= 2 ? (
          <PriceChart series={token.series} />
        ) : (
          <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">trades chart the price</div>
        )}
        <ProgressBar token={token} />
      </div>

      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-5">
        <div className="flex items-center gap-2 mb-3">
          <button
            className={"px-4 py-2 rounded-xl text-sm font-bold " + (tab === "trade" ? "bg-zinc-800 text-white" : "text-zinc-500")}
            onClick={() => setTab("trade")}
          >
            Trade
          </button>
          <button
            className={"px-4 py-2 rounded-xl text-sm font-bold " + (tab === "thread" ? "bg-zinc-800 text-white" : "text-zinc-500")}
            onClick={() => setTab("thread")}
          >
            Thread ({token.comments.length})
          </button>
        </div>
        {tab === "trade" ? (
          <TradePanel
            token={token}
            myHolding={myHolding}
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
          <CommentThread tokenId={token.tokenId} comments={token.comments} account={keys?.address ?? ""} isDev={keys?.address === token.creator} />
        )}
      </div>

      <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-5 space-y-2">
        <p className="text-sm font-bold text-zinc-300">Send tokens</p>
        <input className={inputC} placeholder="nano_… recipient" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
        <div className="flex gap-2">
          <input className={inputC} placeholder="amount" inputMode="decimal" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
          <button className="rounded-xl bg-zinc-800 px-4 py-3 text-sm font-bold hover:bg-zinc-700 shrink-0 disabled:opacity-40" disabled={busy} onClick={transfer}>
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

function SocialLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[11px] text-green-400 hover:underline">
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
      <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-1">
        <span>{graduated ? "graduated · liquidity locked" : "liquidity ramp"}</span>
        <span>{graduated ? "100%" : `${pct.toFixed(2)}%`}</span>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div className="h-full bg-gradient-to-r from-green-500 to-emerald-300" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function TradePanel({
  token,
  myHolding,
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
  const slip = Number(slippage || "0");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>your balance: {fmtTok(myHolding?.balanceRaw, token.decimals)}</span>
        <label className="flex items-center gap-1.5">
          <span className="text-zinc-600">slippage %</span>
          <input
            className="w-14 rounded-lg bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs text-white text-right"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
        </label>
      </div>
      {slip > 0 && <p className="text-[10px] text-zinc-600">slippage protected via commit-reveal</p>}
      <div className="grid grid-cols-2 gap-2">
        <button
          className={"rounded-xl py-2 text-sm font-bold " + (side === "buy" ? "bg-green-500 text-black" : "bg-zinc-800 text-zinc-400")}
          onClick={() => setSide("buy")}
        >
          Buy
        </button>
        <button
          className={"rounded-xl py-2 text-sm font-bold " + (side === "sell" ? "bg-red-500 text-white" : "bg-zinc-800 text-zinc-400")}
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
        {side === "sell" && myHolding && (
          <button
            className="shrink-0 rounded-xl bg-zinc-800 px-3 text-xs font-bold text-zinc-300 hover:bg-zinc-700"
            onClick={() => setAmount(fmtTok(myHolding.balanceRaw, token.decimals))}
          >
            Max
          </button>
        )}
      </div>
      <button className={btn} disabled={busy} onClick={side === "buy" ? buy : sell}>
        {busy ? "…" : side === "buy" ? "Buy (send XNO)" : "Sell tokens"}
      </button>
      <div className="grid grid-cols-3 gap-2">
        <ActionBtn disabled={busy} onClick={() => sendOp(token.tokenId, { kind: "stake", amount: 50_000_000_000n }, "stake")}>
          Stake
        </ActionBtn>
        <ActionBtn disabled={busy} onClick={() => sendOp(token.tokenId, { kind: "unstake", amount: 10_000_000_000n }, "unstake")}>
          Unstake
        </ActionBtn>
        <ActionBtn disabled={busy} onClick={() => sendOp(token.tokenId, { kind: "claim" }, "claim")}>
          Claim
        </ActionBtn>
      </div>
      {token.pool && <p className="text-[11px] text-zinc-600 font-mono break-all">pool: {token.pool}</p>}
    </div>
  );
}

function ActionBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) {
  return (
    <button className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500 disabled:opacity-40" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function TradesPanel({ trades }: { trades: Trade[] }) {
  return (
    <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4">
      <p className="text-sm font-bold text-zinc-300 mb-2">Recent trades</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {trades.length === 0 && <p className="text-xs text-zinc-600">no trades yet</p>}
        {trades.map((t, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 font-mono">{short(t.account)}</span>
            <span className={t.kind === "buy" ? "text-green-400" : "text-red-400"}>
              {t.kind === "buy" ? "▲" : "▼"} {t.kind}
            </span>
            <span className="text-zinc-400">{fmtXno(t.priceRaw)}</span>
            <span className="text-zinc-600">{timeAgo(t.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldersPanel({ holders, creator, decimals }: { holders: Holder[]; creator: string; decimals: number }) {
  const top = holders.slice(0, 20);
  return (
    <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4">
      <p className="text-sm font-bold text-zinc-300 mb-2">Top holders</p>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {top.map((h, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 font-mono flex items-center gap-1">
              {i + 1}. {short(h.account)} {h.account === creator && <span className="text-green-400">dev</span>}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-zinc-400">{fmtTok(h.balanceRaw, decimals)}</span>
              <span className="text-zinc-600 w-12 text-right">{h.pct.toFixed(2)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentThread({ tokenId, comments, account, isDev }: { tokenId: string; comments: Comment[]; account: string; isDev: boolean }) {
  const [text, setText] = useState("");
  const [local, setLocal] = useState<Comment[]>([]);

  async function post() {
    if (!account || !text.trim()) return;
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId, account, text }),
    });
    const j = await res.json();
    if (j.comment) setLocal((l) => [...l, j.comment]);
    setText("");
  }

  const all = [...local, ...comments];
  return (
    <div className="space-y-3">
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {all.length === 0 && <p className="text-xs text-zinc-600">be the first to comment</p>}
        {all.map((c) => (
          <div key={c.id} className="rounded-xl bg-zinc-900/60 p-2.5">
            <p className="text-[11px] text-zinc-500 font-mono">{short(c.account)} · {timeAgo(c.time)}</p>
            <p className="text-xs text-zinc-300 mt-1">{c.text}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={inputC} placeholder="say something…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="shrink-0 rounded-xl bg-zinc-800 px-4 py-3 text-sm font-bold hover:bg-zinc-700" onClick={post}>
          Post
        </button>
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
  onClose,
  onCreated,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  say: (s: string) => void;
  keys: Keys | null;
  submitBlock: (link: string, delta: bigint) => Promise<string>;
  onClose: () => void;
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

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const j = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
      if (j.url) setImage(j.url);
    } catch (e: any) {
      say("upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  }

  async function launch() {
    if (!keys) return say("connect first");
    const decimals = 6;
    const rawSupply = BigInt(Math.floor(Number(supply || "0") * 10 ** decimals)) || 0n;
    if (rawSupply <= 0n) return say("enter supply");
    setBusy(true);
    try {
      const hash = await submitBlock(
        encodeOpLink("", { kind: "launch", supply: rawSupply, name, symbol, decimals, image: "" }),
        1n
      );
      const tokenId = tokenIdFromLaunchHash(hash);
      await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId, name, symbol, decimals, image, description, website, twitter, telegram }),
      });
      say(`launch ✓ ${hash.slice(0, 10)}…`);
      onCreated(tokenId);
    } catch (e: any) {
      say("launch failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-20 p-4" onClick={onClose}>
      <div className="rounded-2xl border border-zinc-800 bg-[#0a0a0a] p-6 w-full max-w-lg space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-black text-lg">Start a new coin</h3>
          <button className="text-zinc-500 hover:text-zinc-300" onClick={onClose}>✕</button>
        </div>
        <div className="flex items-center gap-3">
          <Avatar image={image} symbol={symbol} size={56} />
          <label className="text-xs text-green-400 cursor-pointer">
            {uploading ? "uploading…" : "upload image"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <span className="text-[11px] text-zinc-600">or a URL below</span>
        </div>
        <input className={inputC} placeholder="image URL (optional)" value={image} onChange={(e) => setImage(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className={inputC} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inputC} placeholder="symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </div>
        <input className={inputC} placeholder="supply (whole tokens)" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} />
        <textarea className={inputC} placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div className="grid grid-cols-1 gap-2">
          <input className={inputC} placeholder="website (optional)" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <input className={inputC} placeholder="https://x.com/… (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} />
          <input className={inputC} placeholder="https://t.me/… (optional)" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
        </div>
        <button className={btn} disabled={busy} onClick={launch}>
          {busy ? "launching…" : "Create coin (0.000002 XNO)"}
        </button>
        <p className="text-[11px] text-zinc-600">creator keeps 5% · 1 raw data fee per op</p>
      </div>
    </div>
  );
}