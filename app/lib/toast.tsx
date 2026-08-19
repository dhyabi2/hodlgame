"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { txUrl } from "./explorer";

type ToastKind = "success" | "danger" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastInput {
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Transaction signature — rendered as an explorer link. */
  signature?: string;
  /** A single inline action, typically "Retry". */
  action?: ToastAction;
  /** Override the auto-dismiss delay; 0 keeps it until dismissed. */
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastContextValue {
  push: (kind: ToastKind, title: string, detail?: string) => void;
  /** Richer form — signature, retry action, custom duration. */
  show: (toast: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-holder-success/60 bg-holder-success/10",
  danger: "border-holder-danger/60 bg-holder-danger/10",
  info: "border-holder-violet/60 bg-holder-violet/10",
};

const KIND_TITLE: Record<ToastKind, string> = {
  success: "text-holder-success",
  danger: "text-holder-dangerBright",
  info: "text-holder-violet",
};

/** Read out by screen readers so the emoji is never the only signal. */
const KIND_WORD: Record<ToastKind, string> = {
  success: "Success",
  danger: "Error",
  info: "Notice",
};

const DEFAULT_MS = 6000;
/** Whale alerts arrive in bursts; never stack more than this. */
const MAX_VISIBLE = 4;

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const arm = useCallback(
    (id: number, ms: number) => {
      if (ms <= 0) return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms)
      );
    },
    [dismiss]
  );

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { ...input, id }].slice(-MAX_VISIBLE));
      arm(id, input.durationMs ?? DEFAULT_MS);
    },
    [arm]
  );

  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string) =>
      show({ kind, title, detail }),
    [show]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ push, show, dismiss }), [push, show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        The old container had no role and no aria-live, so a screen-reader user
        was never told a transaction had succeeded or failed. Errors get
        role="alert" (assertive); everything else is polite.
      */}
      <div
        className="fixed z-[80] right-3 left-3 sm:left-auto sm:right-4 flex flex-col gap-2 sm:w-[380px] bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] md:bottom-4"
        aria-live="polite"
        aria-relevant="additions"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              role={t.kind === "danger" ? "alert" : "status"}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={{ duration: 0.2 }}
              onMouseEnter={() => {
                const timer = timers.current.get(t.id);
                if (timer) {
                  clearTimeout(timer);
                  timers.current.delete(t.id);
                }
              }}
              onMouseLeave={() => arm(t.id, 2500)}
              className={`rounded-xl border px-4 py-3 backdrop-blur-md shadow-xl bg-holder-900/90 ${KIND_STYLES[t.kind]}`}
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className={`font-bold ${KIND_TITLE[t.kind]}`}>
                    <span className="sr-only">{KIND_WORD[t.kind]}: </span>
                    {t.title}
                  </p>
                  {t.detail && (
                    <p className="text-sm text-ink-200 mt-1 break-words">
                      {t.detail}
                    </p>
                  )}
                  {(t.signature || t.action) && (
                    <div className="flex items-center gap-4 mt-2">
                      {t.action && (
                        <button
                          onClick={() => {
                            t.action?.onClick();
                            dismiss(t.id);
                          }}
                          className="text-xs font-bold text-holder-accent hover:underline"
                        >
                          {t.action.label}
                        </button>
                      )}
                      {t.signature && (
                        <a
                          href={txUrl(t.signature)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-ink-300 hover:text-holder-accent underline underline-offset-2"
                        >
                          View transaction ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label={`Dismiss: ${t.title}`}
                  className="shrink-0 -mr-1 -mt-1 w-8 h-8 rounded-lg text-ink-400 hover:text-white hover:bg-white/5 transition leading-none"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
