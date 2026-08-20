"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as nanocurrency from "nanocurrency";
import { encodeOpLink } from "../../core/oplink";
import { tokenIdFromLaunchHash } from "../../core/token";
import type { Op } from "../../core/ops";

interface Keys {
  secretKey: string;
  publicKey: string;
  address: string;
}

function keysFromSeed(seed: string): Keys {
  const secretKey = nanocurrency.deriveSecretKey(seed, 0);
  const publicKey = nanocurrency.derivePublicKey(secretKey);
  const address = nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
  return { secretKey, publicKey, address };
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

const fmt = (raw: string | undefined, dec = 30) => {
  if (!raw) return "0";
  const n = BigInt(raw);
  const d = 10n ** BigInt(dec);
  const whole = n / d;
  const frac = (n % d).toString().padStart(dec, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole.toString();
};

interface TokenView {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string;
  launched: boolean;
  supply: string;
  creator: string;
  creatorShare: string;
  treasury: string;
  poolXno: string;
  poolTokens: string;
  totalStaked: string;
  pool: string | null;
  balances: Record<string, string>;
}

const inputC =
  "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-green-500";
const btn =
  "w-full rounded-xl bg-green-500 px-4 py-3 text-sm font-bold text-black hover:bg-green-400 disabled:opacity-40 transition";

export default function Home() {
  const [seed, setSeed] = useState("");
  const [keys, setKeys] = useState<Keys | null>(null);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const j = await (await fetch("/api/state")).json();
      const list: TokenView[] = j.tokens ?? [];
      setTokens(list);
      setSelected((sel) => (sel && list.some((t) => t.tokenId === sel) ? sel : list[0]?.tokenId ?? null));
    } catch (e: any) {
      setLog((l) => [...l.slice(-9), "state: " + e.message]);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const say = (s: string) => setLog((l) => [...l.slice(-9), s]);

  const connect = () => {
    try {
      setKeys(keysFromSeed(seed.trim()));
    } catch {
      say("bad seed");
    }
  };

  const selToken = tokens.find((t) => t.tokenId === selected) ?? null;

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
      refresh();
    } catch (e: any) {
      say(`${label} failed: ${e.message}`);
    } finally {
      setBusy(false);
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
        body: JSON.stringify({ tokenId, name, symbol, decimals }),
      });
      say(`launch ✓ ${hash.slice(0, 10)}…`);
      setSelected(tokenId);
      refresh();
    } catch (e: any) {
      say("launch failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function buy() {
    if (!keys || !selToken?.pool) return say("connect + select a token with a pool");
    const raw = BigInt(Math.floor(Number(amount || "0") * 1e30)) || 0n;
    if (raw <= 0n) return say("enter XNO amount");
    setBusy(true);
    try {
      await submitBlock(encodeOpLink(selToken.tokenId, { kind: "buy", xno: raw, minTokens: 0n }), 1n);
      const hash = await submitBlock(selToken.pool!, raw);
      say(`buy ✓ ${hash.slice(0, 10)}…`);
      setAmount("");
      refresh();
    } catch (e: any) {
      say("buy failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sell() {
    if (!keys || !selToken) return say("select a token");
    const rawTokens = BigInt(Math.floor(Number(amount || "0") * 10 ** selToken.decimals)) || 0n;
    if (rawTokens <= 0n) return say("enter token amount");
    setAmount("");
    await sendOp(selToken.tokenId, { kind: "sell", tokens: rawTokens, minXno: 0n }, "sell");
  }

  return (
    <main className="min-h-screen bg-[#050505] text-white">
      <header className="border-b border-zinc-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎉</span>
          <span className="text-xl font-black tracking-tight bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">
            HoldFun
          </span>
          <span className="text-[11px] text-zinc-500 ml-1">Nano L2 · multi-token</span>
        </div>
        {keys ? (
          <span className="text-xs text-zinc-400 font-mono truncate max-w-[40%]">{keys.address}</span>
        ) : (
          <span className="text-xs text-zinc-500">connect a wallet</span>
        )}
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
          <p className="text-sm font-bold text-zinc-300">Wallet</p>
          <div className="flex gap-2">
            <input className={inputC} placeholder="seed (64 hex)" value={seed} onChange={(e) => setSeed(e.target.value)} />
            <button className="rounded-xl bg-zinc-800 px-4 py-3 text-sm font-bold hover:bg-zinc-700" onClick={connect}>
              Connect
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
          <p className="text-sm font-bold text-zinc-300">Launch a token</p>
          <div className="grid grid-cols-2 gap-2">
            <input className={inputC} placeholder="name (e.g. Dog Coin)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className={inputC} placeholder="symbol (e.g. DOG)" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
          <input className={inputC} placeholder="supply (whole tokens)" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} />
          <button className={btn} disabled={busy} onClick={launch}>
            Launch token
          </button>
        </div>

        {tokens.length > 0 && (
          <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
            <p className="text-sm font-bold text-zinc-300">Tokens</p>
            <div className="flex flex-wrap gap-2">
              {tokens.map((t) => (
                <button
                  key={t.tokenId}
                  onClick={() => setSelected(t.tokenId)}
                  className={
                    "rounded-xl px-3 py-2 text-xs font-bold transition " +
                    (selected === t.tokenId
                      ? "bg-green-500 text-black"
                      : "border border-zinc-800 text-zinc-200 hover:border-green-500")
                  }
                >
                  {t.symbol || t.tokenId.slice(0, 6)} {t.launched ? "●" : "○"}
                </button>
              ))}
            </div>
          </div>
        )}

        {selToken && (
          <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-3xl font-black">{selToken.symbol || "·"}</h2>
              <span className="text-sm text-green-400">{selToken.launched ? "● live" : "○ not launched"}</span>
            </div>
            <p className="text-xs text-zinc-500 font-mono truncate">{selToken.tokenId}</p>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Supply" value={fmt(selToken.supply, selToken.decimals)} />
              <Stat label="Creator (5%)" value={fmt(selToken.creatorShare, selToken.decimals)} />
              <Stat label="Staked" value={fmt(selToken.totalStaked, selToken.decimals)} />
            </div>
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>
                Pool: <span className="text-zinc-300">{fmt(selToken.poolXno)} XNO</span>
              </span>
              <span>
                Reserve: <span className="text-zinc-300">{fmt(selToken.poolTokens, selToken.decimals)}</span>
              </span>
            </div>
            {keys && (
              <p className="text-xs text-zinc-500">
                Your balance: <span className="text-zinc-300">{fmt(selToken.balances?.[keys.address], selToken.decimals)}</span>
              </p>
            )}

            <div className="flex gap-2">
              <input
                className={inputC}
                placeholder="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className={btn} disabled={busy} onClick={buy}>
                Buy (XNO)
              </button>
              <button
                className="rounded-xl bg-red-500 px-4 py-3 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-40"
                disabled={busy}
                onClick={sell}
              >
                Sell
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <ActionBtn disabled={busy} onClick={() => sendOp(selToken.tokenId, { kind: "stake", amount: 50_000_000_000n }, "stake")}>
                Stake
              </ActionBtn>
              <ActionBtn disabled={busy} onClick={() => sendOp(selToken.tokenId, { kind: "unstake", amount: 10_000_000_000n }, "unstake")}>
                Unstake
              </ActionBtn>
              <ActionBtn disabled={busy} onClick={() => sendOp(selToken.tokenId, { kind: "claim" }, "claim")}>
                Claim
              </ActionBtn>
            </div>
            {selToken.pool && (
              <p className="text-[11px] text-zinc-600 font-mono break-all">pool: {selToken.pool}</p>
            )}
          </div>
        )}

        {log.length > 0 && (
          <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 text-xs space-y-1">
            {log.map((l, i) => (
              <p key={i} className="text-zinc-400">
                {l}
              </p>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-900/60 p-3">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="text-lg font-black mt-0.5 truncate">{value}</p>
    </div>
  );
}

function ActionBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) {
  return (
    <button
      className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500 disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}