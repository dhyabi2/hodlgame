"use client";

import { useCallback, useEffect, useState } from "react";
import * as nanocurrency from "nanocurrency";
import { encodeOpCompact } from "../../core/compact";
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

export default function Home() {
  const [seed, setSeed] = useState("");
  const [keys, setKeys] = useState<Keys | null>(null);
  const [state, setState] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state");
      setState(await r.json());
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
    } catch (e: any) {
      say("bad seed");
    }
  };

  async function sendOp(op: Op, label: string) {
    if (!keys) return say("connect first");
    setBusy(true);
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("account not opened — fund it first");
      const link = encodeOpCompact(op);
      const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const balance = (BigInt(info.balance) - 1n).toString();
      const blk = buildBlock(keys.secretKey, { work, previous: info.frontier, representative: info.representative, balance, link });
      const r = await rpc("process", { json_block: "true", block: blk });
      say(`${label} ✓ ${r.hash.slice(0, 10)}…`);
      refresh();
    } catch (e: any) {
      say(`${label} failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function buy() {
    if (!keys || !state?.pool) return say("connect + pool needed");
    const raw = (BigInt(Math.floor(Number(amount || "0") * 1e30)) || 0n).toString();
    if (raw === "0") return say("enter XNO amount");
    setBusy(true);
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const balance = (BigInt(info.balance) - BigInt(raw)).toString();
      const blk = buildBlock(keys.secretKey, { work, previous: info.frontier, representative: info.representative, balance, link: state.pool });
      const r = await rpc("process", { json_block: "true", block: blk });
      say(`buy ✓ ${r.hash.slice(0, 10)}…`);
      setAmount("");
      refresh();
    } catch (e: any) {
      say("buy failed: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-green-500";
  const btn =
    "w-full rounded-xl bg-green-500 px-4 py-3 text-sm font-bold text-black hover:bg-green-400 disabled:opacity-40 transition";

  return (
    <main className="min-h-screen bg-[#050505] text-white">
      <header className="border-b border-zinc-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎉</span>
          <span className="text-xl font-black tracking-tight bg-gradient-to-r from-green-400 to-emerald-300 bg-clip-text text-transparent">
            HoldFun
          </span>
          <span className="text-[11px] text-zinc-500 ml-1">Nano L2</span>
        </div>
        {keys ? (
          <span className="text-xs text-zinc-400 font-mono truncate max-w-[40%]">{keys.address}</span>
        ) : (
          <span className="text-xs text-zinc-500">connect a wallet</span>
        )}
      </header>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Hero stats */}
        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-3xl font-black">{state?.symbol ?? "HOLD"}</h2>
            <span className="text-sm text-green-400">{state?.launched ? "● live" : "○ not launched"}</span>
          </div>
          <p className="text-sm text-zinc-500 mt-1">Creator can only ever own 5%. Holders get paid.</p>
          <div className="grid grid-cols-3 gap-3 mt-5">
            <Stat label="Supply" value={fmt(state?.supply, state?.meta?.decimals ?? 6)} />
            <Stat label="Creator (5%)" value={fmt(state?.creatorShare, state?.meta?.decimals ?? 6)} />
            <Stat label="Staked" value={fmt(state?.totalStaked, state?.meta?.decimals ?? 6)} />
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
            <span>Pool: <span className="text-zinc-300">{fmt(state?.poolXno)} XNO</span></span>
            <span>Token reserve: <span className="text-zinc-300">{fmt(state?.poolTokens, state?.meta?.decimals ?? 6)}</span></span>
          </div>
        </div>

        {/* Wallet */}
        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
          <p className="text-sm font-bold text-zinc-300">Wallet</p>
          <div className="flex gap-2">
            <input className={input} placeholder="seed (64 hex)" value={seed} onChange={(e) => setSeed(e.target.value)} />
            <button className="rounded-xl bg-zinc-800 px-4 py-3 text-sm font-bold hover:bg-zinc-700" onClick={connect}>
              Connect
            </button>
          </div>
        </div>

        {/* Trade */}
        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
          <p className="text-sm font-bold text-zinc-300">Trade</p>
          <div className="flex gap-2">
            <input className={input} placeholder="XNO amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className={btn} disabled={busy} onClick={buy}>Buy</button>
            <button
              className="rounded-xl bg-red-500 px-4 py-3 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-40"
              disabled={busy}
              onClick={() => sendOp({ kind: "sell", tokens: 5_000_000_000n, minXno: 0n }, "sell")}
            >
              Sell
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-6 space-y-3">
          <p className="text-sm font-bold text-zinc-300">Actions</p>
          <div className="grid grid-cols-2 gap-2">
            <button className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500" disabled={busy}
              onClick={() => sendOp({ kind: "launch", supply: 1_000_000_000_000n, name: "", symbol: "", decimals: 6, image: "" }, "launch")}>
              Launch token
            </button>
            <button className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500" disabled={busy}
              onClick={() => sendOp({ kind: "stake", amount: 50_000_000_000n }, "stake")}>
              Stake
            </button>
            <button className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500" disabled={busy}
              onClick={() => sendOp({ kind: "unstake", amount: 10_000_000_000n }, "unstake")}>
              Unstake
            </button>
            <button className="rounded-xl border border-zinc-800 py-3 text-sm font-bold text-zinc-200 hover:border-green-500" disabled={busy}
              onClick={() => sendOp({ kind: "claim" }, "claim")}>
              Claim rebates
            </button>
          </div>
        </div>

        {log.length > 0 && (
          <div className="rounded-2xl border border-zinc-900 bg-[#0a0a0a] p-4 text-xs space-y-1">
            {log.map((l, i) => <p key={i} className="text-zinc-400">{l}</p>)}
          </div>
        )}

        <p className="text-center text-[11px] text-zinc-600">
          devnet-style console · pool: {state?.pool ? state.pool.slice(0, 20) + "…" : "—"}
        </p>
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
