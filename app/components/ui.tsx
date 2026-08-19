"use client";

import { motion, useReducedMotion } from "framer-motion";

/** Shared shell for every panel heading, so peers stop competing for weight. */
export function SectionTitle({
  children,
  right,
  as: Tag = "h2",
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <Tag
        className={
          Tag === "h2"
            ? "font-display text-xl font-bold text-ink-100"
            : "text-sm font-semibold uppercase tracking-wider text-ink-300"
        }
      >
        {children}
      </Tag>
      {right}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-lg bg-holder-700/50 animate-pulse ${className}`}
    />
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-xl bg-holder-900/50 p-3"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="w-6 h-6 rounded-full" />
            <Skeleton className="w-28 h-4" />
          </div>
          <Skeleton className="w-20 h-4" />
        </div>
      ))}
    </div>
  );
}

/**
 * Empty states used to be copy with nowhere to go. Every one now ends in an
 * action.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; onClick?: () => void; href?: string };
}) {
  return (
    <div className="text-center py-10 px-4 space-y-2">
      <p className="text-4xl" aria-hidden>
        {icon}
      </p>
      <p className="text-ink-100 font-medium">{title}</p>
      <p className="text-ink-300 text-sm max-w-xs mx-auto">{body}</p>
      {action &&
        (action.href ? (
          <a
            href={action.href}
            className="inline-block mt-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright transition"
          >
            {action.label}
          </a>
        ) : (
          <button
            onClick={action.onClick}
            className="mt-2 px-5 py-2.5 rounded-xl text-sm font-bold bg-holder-accent text-holder-900 hover:bg-holder-accentBright transition"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}

/**
 * What a panel shows when its RPC read fails. The old behaviour was a
 * `console.error` and a permanent `0` — indistinguishable from an empty vault.
 */
export function LoadError({
  what,
  onRetry,
}: {
  what: string;
  onRetry: () => void;
}) {
  return (
    <div className="text-center py-8 px-4 space-y-3" role="alert">
      <p className="text-3xl" aria-hidden>
        📡
      </p>
      <p className="text-ink-200 text-sm">
        Couldn&apos;t reach the network to load {what}.
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-xl text-sm font-medium border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent transition"
      >
        Try again
      </button>
    </div>
  );
}

export function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`animate-spin ${className}`}
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

type ButtonTone = "accent" | "danger" | "jackpot" | "ghost" | "success";

const TONES: Record<ButtonTone, string> = {
  accent:
    "bg-holder-accent text-holder-900 hover:bg-holder-accentBright shadow-glow-accent",
  danger: "bg-holder-danger text-white hover:bg-holder-dangerBright",
  jackpot:
    "bg-holder-jackpot text-holder-900 hover:bg-holder-jackpotBright shadow-glow-gold",
  success:
    "border border-holder-success text-holder-success hover:bg-holder-success/10",
  ghost: "border border-holder-700 text-ink-200 hover:border-holder-accent hover:text-holder-accent",
};

/**
 * A submit button that says what it's doing and why it can't. `disabledReason`
 * is rendered under the button rather than leaving the user to guess at a
 * greyed-out control.
 */
export function ActionButton({
  onClick,
  children,
  tone = "accent",
  loading,
  loadingLabel = "Confirming…",
  disabled,
  disabledReason,
  type = "button",
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: ButtonTone;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  disabledReason?: string | null;
  type?: "button" | "submit";
}) {
  const reduceMotion = useReducedMotion();
  const isDisabled = disabled || loading;

  return (
    <div className="space-y-1.5">
      <motion.button
        type={type}
        onClick={onClick}
        disabled={isDisabled}
        aria-busy={loading}
        whileHover={reduceMotion || isDisabled ? undefined : { scale: 1.02 }}
        whileTap={reduceMotion || isDisabled ? undefined : { scale: 0.98 }}
        className={`w-full min-h-[48px] py-3 px-4 rounded-xl font-bold transition flex items-center justify-center gap-2 disabled:opacity-45 disabled:shadow-none disabled:cursor-not-allowed ${TONES[tone]}`}
      >
        {loading && <Spinner />}
        <span>{loading ? loadingLabel : children}</span>
      </motion.button>
      {!loading && disabled && disabledReason && (
        <p className="text-xs text-ink-400 text-center">{disabledReason}</p>
      )}
    </div>
  );
}

/** Label/value row used by the pre-transaction receipts. */
export function ReceiptRow({
  label,
  value,
  tone,
  emphasis,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-300">{label}</span>
      <span
        className={`stat-number tabular-nums ${emphasis ? "font-bold" : ""} ${
          tone ?? "text-ink-100"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
