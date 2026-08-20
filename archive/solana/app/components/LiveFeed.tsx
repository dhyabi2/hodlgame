"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AnchorProvider, Program, EventParser } from "@coral-xyz/anchor";
import { PROGRAM_ID } from "@/lib/program";
import { formatAmount } from "@/lib/amount";
import { useMint } from "@/lib/mint";
import {
  playStake,
  playTax,
  playClaim,
  playSwap,
  playWhaleAlert,
} from "@/lib/sound";
import { useToast } from "@/lib/toast";
import { chronicleLine } from "@/lib/chronicle";
import { txUrl, shortAddress } from "@/lib/explorer";
import { EmptyState, SectionTitle } from "./ui";
import idl from "@/lib/idl.json";

type FeedKind = "stake" | "unstake" | "claim" | "swap";

interface FeedEvent {
  id: string;
  signature: string;
  kind: FeedKind;
  user: string;
  amount: string;
  tax?: string;
  burn?: string;
  swapIn?: string;
  swapOut?: string;
  time: number;
}

const HISTORY_LIMIT = 15;
const MAX_EVENTS = 40;
const WHALE_THRESHOLD = 10_000;

const FILTERS = [
  { id: "all", label: "All", kinds: null },
  { id: "stake", label: "Stakes", kinds: ["stake"] },
  { id: "exit", label: "Exits", kinds: ["unstake"] },
  { id: "reward", label: "Rebates", kinds: ["claim"] },
] as const;

function isWhale(amountStr: string): boolean {
  const n = parseFloat(amountStr.replace(/,/g, ""));
  return Number.isFinite(n) && n >= WHALE_THRESHOLD;
}

/** "just now" / "4m ago" / "2h ago" — a wall-clock time tells you nothing here. */
function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function mapEvent(
  name: string,
  data: any,
  signature: string,
  time: number
): FeedEvent | null {
  const base = { id: `${signature}-${name}`, signature, time };
  if (name === "StakeEvent") {
    return { ...base, kind: "stake", user: data.user.toBase58(), amount: formatAmount(data.amount) };
  }
  if (name === "UnstakeEvent") {
    return {
      ...base,
      kind: "unstake",
      user: data.user.toBase58(),
      amount: formatAmount(data.amount),
      tax: formatAmount(data.tax),
      burn: formatAmount(data.burn),
    };
  }
  if (name === "ClaimEvent") {
    return { ...base, kind: "claim", user: data.user.toBase58(), amount: formatAmount(data.amount) };
  }
  if (name === "SwapEvent") {
    const solStr = formatAmount(data.solAmount, 9);
    const holdStr = formatAmount(data.holdAmount);
    return {
      ...base,
      kind: "swap",
      user: data.user.toBase58(),
      amount: data.solToHold ? holdStr : solStr,
      swapIn: data.solToHold ? `${solStr} SOL` : `${holdStr} HOLD`,
      swapOut: data.solToHold ? `${holdStr} HOLD` : `${solStr} SOL`,
    };
  }
  return null;
}

export function LiveFeed({ onStake }: { onStake?: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const { symbol, decimals } = useMint();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [chronicle, setChronicle] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
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
      setFlashIds((prev) => new Set(prev).add(ev.id));
      setTimeout(() => {
        setFlashIds((prev) => {
          const next = new Set(prev);
          next.delete(ev.id);
          return next;
        });
      }, 1200);
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
          setEvents(history.sort((a, b) => b.time - a.time).slice(0, MAX_EVENTS));
        }
      } catch (err) {
        console.error("live feed history error", err);
      }
    })();

    const listeners = [
      program.addEventListener("StakeEvent", (data, _slot, signature) => {
        const ev = mapEvent("StakeEvent", data, signature, Date.now());
        if (!ev) return;
        pushEvent(ev);
        if (isWhale(ev.amount)) {
          playWhaleAlert();
          toast.push("info", "🐋 Whale alert", `${ev.amount} ${symbol} just entered the vault.`);
        } else {
          playStake();
        }
      }),
      program.addEventListener("UnstakeEvent", (data, _slot, signature) => {
        const ev = mapEvent("UnstakeEvent", data, signature, Date.now());
        if (!ev) return;
        pushEvent(ev);
        if (isWhale(ev.amount)) {
          playWhaleAlert();
          toast.push("info", "🐋 Whale alert", `${ev.amount} ${symbol} just left — the vault ate well.`);
        } else {
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
    ];

    return () => {
      cancelled = true;
      listeners.forEach((id) => {
        program.removeEventListener(id).catch(() => {});
      });
    };
  }, [connection, wallet.publicKey, toast]);

  const active = FILTERS.find((f) => f.id === filter)!;
  const visible = useMemo(
    () =>
      active.kinds
        ? events.filter((e) => (active.kinds as readonly string[]).includes(e.kind))
        : events,
    [events, active]
  );

  return (
    <div id="activity" className="panel p-5 sm:p-6 h-full flex flex-col scroll-mt-24">
      <SectionTitle
        right={
          <button
            onClick={() => setChronicle((c) => !c)}
            aria-pressed={chronicle}
            className="min-h-[36px] px-3 rounded-lg border border-holder-700 text-xs text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
          >
            {chronicle ? "📊 Raw numbers" : "📜 Narrate it"}
          </button>
        }
      >
        {chronicle ? "The Chronicle" : "Live Feed"}
      </SectionTitle>

      <div className="flex gap-1.5 mt-4 mb-3 flex-wrap" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`min-h-[32px] px-3 rounded-lg text-xs font-medium transition ${
              filter === f.id
                ? "bg-holder-accent text-holder-900"
                : "border border-holder-700 text-ink-300 hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-2 overflow-y-auto pr-1 flex-1 min-h-[240px] max-h-[560px]">
        <AnimatePresence initial={false}>
          {visible.length === 0 ? (
            <EmptyState
              icon="💎"
              title={
                events.length === 0
                  ? "The vault is quiet… for now."
                  : "Nothing of that kind yet."
              }
              body={
                events.length === 0
                  ? "Be the first diamond hand — every stake, exit and win shows up here the moment it lands."
                  : "Switch filters, or make it happen yourself."
              }
              action={
                events.length === 0 && onStake
                  ? { label: "Stake first", onClick: onStake }
                  : undefined
              }
            />
          ) : (
            visible.map((ev) => (
              <FeedRow
                key={ev.id}
                ev={ev}
                flash={flashIds.has(ev.id)}
                chronicle={chronicle}
                isYou={wallet.publicKey?.toBase58() === ev.user}
                symbol={symbol}
              />
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const KIND_CONFIG: Record<
  FeedKind,
  { icon: string; label: string; color: string; border: string }
> = {
  stake: {
    icon: "💎",
    label: "Staked",
    color: "text-holder-accent",
    border: "border-holder-accent/30",
  },
  unstake: {
    icon: "🧻",
    label: "Paper hands exit",
    color: "text-holder-dangerBright",
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
    color: "text-ink-100",
    border: "border-holder-700",
  },
};

function FeedRow({
  ev,
  flash,
  chronicle,
  isYou,
  symbol,
}: {
  ev: FeedEvent;
  flash?: boolean;
  chronicle?: boolean;
  isYou?: boolean;
  symbol: string;
}) {
  const config = KIND_CONFIG[ev.kind];
  const when = (
    <a
      href={txUrl(ev.signature)}
      target="_blank"
      rel="noopener noreferrer"
      title={new Date(ev.time).toLocaleString()}
      className="text-xs text-ink-400 hover:text-holder-accent transition"
    >
      {relativeTime(ev.time)} ↗
    </a>
  );

  const shell = `rounded-xl bg-holder-900/50 border p-3 ${config.border} ${
    isYou ? "ring-1 ring-holder-accent/40" : ""
  } ${flash ? "animate-flash-accent" : ""}`;

  if (chronicle) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className={`flex items-start gap-3 ${shell}`}
      >
        <span className="text-xl leading-none mt-0.5" aria-hidden>
          {config.icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-ink-200 leading-snug italic">
            {chronicleLine({
              id: ev.id,
              kind: ev.kind,
              user: ev.user,
              amount: ev.amount,
            })}
          </p>
          <div className="mt-1">{when}</div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`flex items-center justify-between gap-3 ${shell}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xl shrink-0" aria-hidden>
          {config.icon}
        </span>
        <div className="min-w-0">
          <p className={`font-semibold text-sm ${config.color}`}>{config.label}</p>
          <p className="text-xs text-ink-400 font-mono truncate">
            {isYou ? "You" : shortAddress(ev.user)}
          </p>
        </div>
      </div>
      <div className="text-right shrink-0">
        {ev.kind === "swap" ? (
          <p className="font-bold text-sm stat-number tabular-nums">
            {ev.swapIn} → {ev.swapOut}
          </p>
        ) : (
          <p className="font-bold text-sm stat-number tabular-nums">
            {ev.amount} {symbol}
          </p>
        )}
        {ev.tax && (
          <p className="text-xs text-holder-dangerBright">
            −{ev.tax} tax
            {ev.burn && parseFloat(ev.burn.replace(/,/g, "")) > 0 && (
              <span className="text-orange-400"> · 🔥 {ev.burn}</span>
            )}
          </p>
        )}
        {when}
      </div>
    </motion.div>
  );
}
