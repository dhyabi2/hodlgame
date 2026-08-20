import { BN } from "@coral-xyz/anchor";

/**
 * Token amounts, done without floats.
 *
 * The old path was `new BN(parseFloat(amount) * 1e6)`, which loses precision
 * above ~9e9 base units and silently produces a different number than the one
 * the user typed. Everything here works on the decimal *string* instead, so
 * what you type is exactly what gets signed.
 */

/** Strips grouping and anything that isn't a digit or a single decimal point. */
export function sanitizeDecimalInput(raw: string, decimals = 6): string {
  let s = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    // Keep only the first decimal point.
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    const [whole, frac] = s.split(".");
    s = `${whole}.${frac.slice(0, decimals)}`;
  }
  // "007" -> "7", but leave "0.x" and a lone "0" alone.
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

/**
 * Decimal string -> base units. Returns null for anything that isn't a
 * non-negative number, so callers can distinguish "empty" from "zero".
 */
export function parseAmount(input: string, decimals = 6): BN | null {
  const s = sanitizeDecimalInput(input, decimals);
  if (s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (whole === "" && frac === "") return null;
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  const digits = `${whole || "0"}${padded}`.replace(/^0+(?=\d)/, "");
  try {
    return new BN(digits || "0");
  } catch {
    return null;
  }
}

/** Base units -> plain decimal string, no grouping. Round-trips with parseAmount. */
export function toDecimalString(amount: BN, decimals = 6): string {
  const divisor = new BN(10).pow(new BN(decimals));
  const whole = amount.div(divisor).toString();
  const frac = amount.mod(divisor).toString().padStart(decimals, "0");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display formatting: thousands separators, at least `min` decimals, at most
 * `max`, trailing zeros trimmed past the minimum. `1000000` reads as
 * "1,000,000.00" instead of the old "1000000.0000".
 */
export function formatAmount(
  amount: BN | number | string,
  decimals = 6,
  { min = 2, max = 4 }: { min?: number; max?: number } = {}
): string {
  const bn = BN.isBN(amount) ? amount : new BN(amount.toString());
  const negative = bn.isNeg();
  const abs = negative ? bn.neg() : bn;

  const divisor = new BN(10).pow(new BN(decimals));
  const whole = abs.div(divisor).toString();
  const fracFull = abs.mod(divisor).toString().padStart(decimals, "0");

  let frac = fracFull.slice(0, max);
  while (frac.length > min && frac.endsWith("0")) frac = frac.slice(0, -1);

  const body = frac.length > 0 ? `${group(whole)}.${frac}` : group(whole);
  return negative ? `-${body}` : body;
}

/** Large numbers as "1.2M" / "34.5K" — for headline stats where digits are noise. */
export function formatCompact(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Percentage of a BN, exactly — `bps` of 2000 is 20%. */
export function bpsOf(amount: BN, bps: number): BN {
  return amount.muln(bps).divn(10000);
}

/** "2d 4h", "4h 12m", "38m" — compact duration for countdowns and tier ETAs. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
