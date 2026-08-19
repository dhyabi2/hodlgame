"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PollStatus = "loading" | "ready" | "error";

interface PollOptions {
  /** Base interval between successful reads. */
  intervalMs: number;
  /** Skip scheduling entirely (e.g. no wallet connected). */
  enabled?: boolean;
  /** Randomised first-run delay so seven panels don't hit the RPC in the same tick. */
  staggerMs?: number;
}

/**
 * Visibility-aware polling with exponential backoff.
 *
 * Three problems this exists to solve, all of which the app had:
 *  - seven independent `setInterval`s hammering a public devnet RPC,
 *  - every one of them still running in a background tab,
 *  - a 429 or a dropped read leaving the panel silently stuck on zero forever.
 *
 * Failures back off (2x up to 2 minutes) and surface as `status: "error"` so a
 * panel can show a retry affordance instead of pretending the vault is empty.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs, enabled = true, staggerMs = 0 }: PollOptions,
  deps: unknown[] = []
) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<PollStatus>("loading");
  const [error, setError] = useState<Error | null>(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const runRef = useRef<(immediate?: boolean) => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      setStatus("loading");
      return;
    }

    let cancelled = false;
    let controller = new AbortController();
    // The visibility gate must not apply to the very first read, or a page
    // opened in a background tab sits on skeletons until it's focused.
    let hasLoaded = false;

    const schedule = (ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(run, ms);
    };

    async function run() {
      if (cancelled) return;
      // After the first read, a hidden tab has no reader — don't spend RPC on it.
      if (hasLoaded && typeof document !== "undefined" && document.hidden) {
        schedule(5000);
        return;
      }
      controller.abort();
      controller = new AbortController();
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        failures.current = 0;
        hasLoaded = true;
        setData(result);
        setError(null);
        setStatus("ready");
        schedule(intervalMs);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        failures.current += 1;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus((s) => (s === "ready" ? "ready" : "error"));
        // Backoff: 2x per failure, capped at two minutes.
        schedule(Math.min(intervalMs * 2 ** failures.current, 120_000));
      }
    }

    runRef.current = (immediate = true) => {
      failures.current = 0;
      schedule(immediate ? 0 : intervalMs);
    };

    schedule(staggerMs);

    // Coming back to the tab should refresh now, not at the next tick.
    const onVisible = () => {
      if (!document.hidden) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, staggerMs, ...deps]);

  const refetch = useCallback(() => runRef.current(true), []);

  return { data, status, error, refetch };
}

/**
 * Marks a value as genuinely unknown rather than zero. A failed read used to
 * render as `0`, which reads as "the vault is empty" — a lie.
 */
export function unknownOr<T>(status: PollStatus, value: T | null, fallback: T): T {
  return status === "ready" && value !== null ? value : fallback;
}
