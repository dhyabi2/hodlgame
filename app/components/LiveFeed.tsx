"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AnchorProvider, Program, EventParser } from "@coral-xyz/anchor";
import { PROGRAM_ID, formatAmount } from "@/lib/program";
import { playStake, playTax, playClaim, playSwap, playRaffleWin } from "@/lib/sound";
import idl from "@/lib/idl.json";

interface FeedEvent {
  id: string;
  kind: "stake" | "unstake" | "claim" | "swap" | "raffle";
  user: string;
  amount: string;
  tax?: string;
  burn?: string;
  swapIn?: string;
  swapOut?: string;
  round?: number;
  time: number;
}

const HISTORY_LIMIT = 15;
const MAX_EVENTS = 40;

function mapEvent(
  name: string,
  data: any,
  signature: string,
  time: number
): FeedEvent | null {
  const id = `${signature}-${name}`;
  if (name === "StakeEvent") {
    return {
      id,
      kind: "stake",
      user: data.user.toBase58(),
      amount: formatAmount(data.amount),
      time,
    };
  }
  if (name === "UnstakeEvent") {
    return {
      id,
      kind: "unstake",
      user: data.user.toBase58(),
      amount: formatAmount(data.amount),
      tax: formatAmount(data.tax),
      burn: formatAmount(data.burn),
      time,
    };
  }
  if (name === "ClaimEvent") {
    return {
      id,
      kind: "claim",
      user: data.user.toBase58(),
      amount: formatAmount(data.amount),
      time,
    };
  }
  if (name === "SwapEvent") {
    const solStr = formatAmount(data.solAmount, 9);
    const holdStr = formatAmount(data.holdAmount);
    return {
      id,
      kind: "swap",
      user: data.user.toBase58(),
      amount: data.solToHold ? holdStr : solStr,
      swapIn: data.solToHold ? `${solStr} SOL` : `${holdStr} HOLD`,
      swapOut: data.solToHold ? `${holdStr} HOLD` : `${solStr} SOL`,
      time,
    };
  }
  if (name === "RaffleEvent") {
    return {
      id,
      kind: "raffle",
      user: data.winner.toBase58(),
      amount: formatAmount(data.prize),
      round: Number(data.round),
      time,
    };
  }
  return null;
}

export function LiveFeed() {
  const { connection } = useConnection();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program<any>(idl as any, PROGRAM_ID, provider);
    const parser = new EventParser(PROGRAM_ID, program.coder);

    function pushEvent(ev: FeedEvent) {
      if (seen.current.has(ev.id)) return;
      seen.current.add(ev.id);
      setEvents((prev) => [ev, ...prev].slice(0, MAX_EVENTS));
    }

    (async () => {
      try {
        const sigs = await connection.getSignaturesForAddress(PROGRAM_ID, {
          limit: HISTORY_LIMIT,
        });
        const history: FeedEvent[] = [];
        for (const sig of sigs) {
          if (sig.err) continue;
          const tx = await connection.getTransaction(sig.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = tx?.meta?.logMessages;
          if (!logs) continue;
          for (const parsed of parser.parseLogs(logs)) {
            const mapped = mapEvent(
              parsed.name,
              parsed.data,
              sig.signature,
              (sig.blockTime ?? Date.now() / 1000) * 1000
            );
            if (mapped) history.push(mapped);
          }
        }
        if (!cancelled) {
          history.forEach((e) => seen.current.add(e.id));
          setEvents(
            history.sort((a, b) => b.time - a.time).slice(0, MAX_EVENTS)
          );
        }
      } catch (err) {
        console.error("live feed history error", err);
      }
    })();

    const listeners = [
      program.addEventListener("StakeEvent", (data, _slot, signature) => {
        const ev = mapEvent("StakeEvent", data, signature, Date.now());
        if (ev) {
          pushEvent(ev);
          playStake();
        }
      }),
      program.addEventListener("UnstakeEvent", (data, _slot, signature) => {
        const ev = mapEvent("UnstakeEvent", data, signature, Date.now());
        if (ev) {
          pushEvent(ev);
          playTax();
        }
      }),
      program.addEventListener("ClaimEvent", (data, _slot, signature) => {
        const ev = mapEvent("ClaimEvent", data, signature, Date.now());
        if (ev) {
          pushEvent(ev);
          playClaim();
        }
      }),
      program.addEventListener("SwapEvent", (data, _slot, signature) => {
        const ev = mapEvent("SwapEvent", data, signature, Date.now());
        if (ev) {
          pushEvent(ev);
          playSwap();
        }
      }),
      program.addEventListener("RaffleEvent", (data, _slot, signature) => {
        const ev = mapEvent("RaffleEvent", data, signature, Date.now());
        if (ev) {
          pushEvent(ev);
          playRaffleWin();
        }
      }),
    ];

    return () => {
      cancelled = true;
      listeners.forEach((id) => {
        program.removeEventListener(id).catch(() => {});
      });
    };
  }, [connection]);

  return (
    <div className="rounded-2xl border border-holder-700 bg-holder-800/60 p-6 h-full flex flex-col">
      <h2 className="text-2xl font-bold mb-4">Live Feed</h2>
      <div className="space-y-2 overflow-y-auto pr-1 flex-1 max-h-[520px]">
        <AnimatePresence initial={false}>
          {events.length === 0 ? (
            <p className="text-slate-400 text-center py-8">
              No events yet. Be the first diamond hand.
            </p>
          ) : (
            events.map((ev) => <FeedRow key={ev.id} ev={ev} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const KIND_CONFIG = {
  stake: {
    icon: "💎",
    label: "Diamond hands staked",
    color: "text-holder-accent",
    border: "border-holder-accent/30",
  },
  unstake: {
    icon: "🧻",
    label: "PAPER HANDS",
    color: "text-holder-danger",
    border: "border-holder-danger/40",
  },
  claim: {
    icon: "✨",
    label: "Claimed rebate",
    color: "text-holder-jackpot",
    border: "border-holder-jackpot/30",
  },
  swap: {
    icon: "🔄",
    label: "Swapped",
    color: "text-holder-accent",
    border: "border-holder-accent/30",
  },
  raffle: {
    icon: "🎉",
    label: "Won the Diamond Raffle",
    color: "text-holder-jackpot",
    border: "border-holder-jackpot/50",
  },
} as const;

function FeedRow({ ev }: { ev: FeedEvent }) {
  const config = KIND_CONFIG[ev.kind];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`flex items-center justify-between rounded-xl bg-holder-900/50 border ${config.border} p-3`}
    >
      <div className="flex items-center gap-3">
        <span className="text-xl">{config.icon}</span>
        <div>
          <p className={`font-medium text-sm ${config.color}`}>
            {config.label}
          </p>
          <p className="text-xs text-slate-500 font-mono">
            {ev.user.slice(0, 4)}...{ev.user.slice(-4)}
          </p>
        </div>
      </div>
      <div className="text-right">
        {ev.kind === "swap" ? (
          <p className="font-bold text-sm">
            {ev.swapIn} → {ev.swapOut}
          </p>
        ) : (
          <p className="font-bold text-sm">
            {ev.amount} HOLD
            {ev.tax && (
              <span className="text-holder-danger text-xs ml-2">
                -{ev.tax} tax
              </span>
            )}
            {ev.burn && parseFloat(ev.burn) > 0 && (
              <span className="text-orange-400 text-xs ml-2">
                🔥 {ev.burn} burned
              </span>
            )}
          </p>
        )}
        <p className="text-xs text-slate-500">
          {new Date(ev.time).toLocaleTimeString()}
        </p>
      </div>
    </motion.div>
  );
}
