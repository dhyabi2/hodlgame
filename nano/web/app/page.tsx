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

export default function Home() {
  const [seed, setSeed] = useState("");
  const [keys, setKeys] = useState<Keys | null>(null);
  const [state, setState] = useState<any>(null);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state");
      setState(await r.json());
    } catch (e: any) {
      setLog((l) => [...l, "state: " + e.message]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const say = (s: string) => setLog((l) => [...l.slice(-9), s]);

  const connect = () => {
    try {
      setKeys(keysFromSeed(seed.trim()));
    } catch (e: any) {
      say("bad seed: " + e.message);
    }
  };

  async function sendOp(op: Op, label: string) {
    if (!keys) return say("connect first");
    try {
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      if (!info.frontier) return say("account not opened — fund it first");
      const link = encodeOpCompact(op);
      const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const balance = (BigInt(info.balance) - 1n).toString();
      const blk = buildBlock(keys.secretKey, { work, previous: info.frontier, representative: info.representative, balance, link });
      const r = await rpc("process", { json_block: "true", block: blk });
      say(`${label} → ${r.hash.slice(0, 12)}…`);
      refresh();
    } catch (e: any) {
      say(`${label} failed: ${e.message}`);
    }
  }

  async function buy() {
    if (!keys || !state?.pool) return say("connect + pool needed");
    try {
      const amt = prompt("XNO to spend (raw)?", "1000000000000000000000000000")!;
      const info = await rpc("account_info", { account: keys.address, representative: "true" });
      const work = (await rpc("work_generate", { hash: info.frontier, difficulty: "fffffff800000000" })).work;
      const balance = (BigInt(info.balance) - BigInt(amt)).toString();
      const blk = buildBlock(keys.secretKey, { work, previous: info.frontier, representative: info.representative, balance, link: state.pool });
      const r = await rpc("process", { json_block: "true", block: blk });
      say(`buy (send XNO to pool) → ${r.hash.slice(0, 12)}…`);
      refresh();
    } catch (e: any) {
      say("buy failed: " + e.message);
    }
  }

  const input = "w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white";
  const btn = "rounded bg-green-500 px-3 py-2 text-sm font-bold text-black hover:bg-green-400 disabled:opacity-40";

  return (
    <main className="min-h-screen bg-black text-white p-6 font-mono">
      <div className="max-w-xl mx-auto space-y-4">
        <h1 className="text-xl font-bold">HoldFun · Nano L2 (dev console)</h1>

        <div>
          <input className={input} placeholder="seed (64 hex)" value={seed} onChange={(e) => setSeed(e.target.value)} />
          <button className={btn + " ml-2"} onClick={connect}>Connect</button>
          {keys && <p className="text-xs text-zinc-400 mt-1">account: {keys.address}</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={() => sendOp({ kind: "launch", supply: 1_000_000_000_000n, name: "", symbol: "", decimals: 6, image: "" }, "launch")}>Launch</button>
          <button className={btn} onClick={buy}>Buy</button>
          <button className={btn} onClick={() => sendOp({ kind: "sell", tokens: 5_000_000_000n, minXno: 0n }, "sell")}>Sell</button>
          <button className={btn} onClick={() => sendOp({ kind: "stake", amount: 50_000_000_000n }, "stake")}>Stake</button>
          <button className={btn} onClick={() => sendOp({ kind: "unstake", amount: 10_000_000_000n }, "unstake")}>Unstake</button>
          <button className={btn} onClick={() => sendOp({ kind: "claim" }, "claim")}>Claim</button>
          <button className="rounded bg-zinc-700 px-3 py-2 text-sm" onClick={refresh}>Refresh</button>
        </div>

        <div className="rounded border border-zinc-800 bg-zinc-900 p-4 text-xs space-y-1">
          <p className="text-zinc-500">STATE</p>
          {state?.error ? <p className="text-red-400">{state.error}</p> : (
            <>
              <p>pool: <span className="text-green-400">{state?.pool ?? "—"}</span></p>
              <p>launched: {String(state?.launched)} · symbol: {state?.symbol}</p>
              <p>supply: {state?.supply} · creator share: {state?.creatorShare} · treasury: {state?.treasury}</p>
              <p>staked: {state?.totalStaked} · rebate vault: {state?.rebateVault}</p>
              <p>poolXno: {state?.poolXno} · poolTokens: {state?.poolTokens}</p>
              <p>events: {state?.events}</p>
            </>
          )}
        </div>

        {log.length > 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs space-y-1">
            {log.map((l, i) => <p key={i} className="text-zinc-300">{l}</p>)}
          </div>
        )}
      </div>
    </main>
  );
}
