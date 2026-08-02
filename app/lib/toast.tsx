"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type ToastKind = "success" | "danger" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-holder-success/60 bg-holder-success/10 text-holder-success",
  danger: "border-holder-danger/60 bg-holder-danger/10 text-holder-danger",
  // Violet, not brand cyan — system information shouldn't wear the brand color.
  info: "border-holder-violet/60 bg-holder-violet/10 text-holder-violet",
};

const KIND_ICON: Record<ToastKind, string> = {
  success: "💎",
  danger: "🧻",
  info: "ℹ️",
};

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, kind, title, detail }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    []
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(360px,calc(100vw-2rem))]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-slide-in rounded-xl border px-4 py-3 backdrop-blur-sm shadow-lg ${KIND_STYLES[t.kind]}`}
          >
            <p className="font-bold flex items-center gap-2">
              <span>{KIND_ICON[t.kind]}</span>
              {t.title}
            </p>
            {t.detail && (
              <p className="text-sm text-ink-200 mt-1">{t.detail}</p>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
