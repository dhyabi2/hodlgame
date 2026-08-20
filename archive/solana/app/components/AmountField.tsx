"use client";

import { useId } from "react";
import { BN } from "@coral-xyz/anchor";
import {
  formatAmount,
  parseAmount,
  sanitizeDecimalInput,
  toDecimalString,
} from "@/lib/amount";

const PERCENTS = [25, 50, 75] as const;

export interface AmountValidation {
  /** Parsed value, null when the field is empty or unparseable. */
  value: BN | null;
  /** Blocking problem, shown inline and used to disable the submit button. */
  error: string | null;
  /** Non-blocking note (e.g. "this leaves nothing for fees"). */
  warning: string | null;
}

/**
 * Everything the old raw `<input type="number">` didn't do: validate against a
 * real balance before the wallet ever sees it, tell the user *why* the button
 * is dead, and parse without floats.
 */
export function validateAmount(
  raw: string,
  {
    balance,
    decimals = 6,
    symbol,
    minLabel,
  }: { balance: BN | null; decimals?: number; symbol: string; minLabel?: string }
): AmountValidation {
  const value = parseAmount(raw, decimals);
  if (raw.trim() === "") return { value: null, error: null, warning: null };
  if (value === null) return { value: null, error: "Enter a valid amount.", warning: null };
  if (value.isZero()) {
    return { value, error: `Amount must be more than 0 ${symbol}.`, warning: null };
  }
  if (balance !== null && value.gt(balance)) {
    return {
      value,
      error: `You only have ${formatAmount(balance, decimals)} ${symbol}${
        minLabel ? ` ${minLabel}` : ""
      }.`,
      warning: null,
    };
  }
  return { value, error: null, warning: null };
}

export function AmountField({
  label,
  value,
  onChange,
  symbol,
  balance,
  balanceLabel = "Balance",
  /** Cap for the MAX chip — defaults to the full balance. */
  spendable,
  decimals = 6,
  error,
  hint,
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  symbol: string;
  balance: BN | null;
  balanceLabel?: string;
  spendable?: BN | null;
  decimals?: number;
  error?: string | null;
  hint?: React.ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const cap = spendable ?? balance;
  const canQuickFill = cap !== null && cap.gtn(0) && !disabled;

  const setPercent = (pct: number) => {
    if (!cap) return;
    const part = pct === 100 ? cap : cap.muln(pct).divn(100);
    onChange(toDecimalString(part, decimals));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-ink-200">
          {label}
        </label>
        <span className="text-xs text-ink-400 tabular-nums">
          {balanceLabel}:{" "}
          <span className="text-ink-200">
            {balance === null ? "—" : formatAmount(balance, decimals)} {symbol}
          </span>
        </span>
      </div>

      <div
        className={`flex items-stretch rounded-xl border bg-holder-900 transition focus-within:border-holder-accent ${
          error ? "border-holder-danger" : "border-holder-700"
        }`}
      >
        <input
          id={id}
          // `inputMode="decimal"` gives iOS the numeric keypad; `type="text"`
          // keeps the browser from accepting "-", "e" and scientific notation.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(sanitizeDecimalInput(e.target.value, decimals))}
          placeholder="0.00"
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="flex-1 min-w-0 bg-transparent px-4 py-3 text-lg stat-number text-white placeholder-ink-500 focus:outline-none disabled:opacity-50"
        />
        <span className="flex items-center px-3 text-sm font-semibold text-ink-200 border-l border-holder-700">
          {symbol}
        </span>
      </div>

      {canQuickFill && (
        <div className="flex gap-2">
          {PERCENTS.map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => setPercent(pct)}
              className="flex-1 min-h-[36px] rounded-lg border border-holder-700 text-xs font-medium text-ink-300 hover:border-holder-accent hover:text-holder-accent transition"
            >
              {pct}%
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPercent(100)}
            className="flex-1 min-h-[36px] rounded-lg border border-holder-accent/60 bg-holder-accent/10 text-xs font-bold text-holder-accent hover:bg-holder-accent/20 transition"
          >
            MAX
          </button>
        </div>
      )}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-holder-dangerBright flex items-start gap-1.5">
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </p>
      ) : (
        hint && <div className="text-xs text-ink-400">{hint}</div>
      )}
    </div>
  );
}
