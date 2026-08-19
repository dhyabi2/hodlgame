"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog primitive the app didn't have.
 *
 * LoreModal previously rendered an overlay with no `role`, no `aria-modal`, no
 * accessible name, no focus trap and no focus restoration — Tab walked straight
 * out of the dialog into the page behind it, and a screen reader was never told
 * anything had opened.
 */
export function Modal({
  open,
  onClose,
  title,
  /** Rendered instead of a plain title when the header needs controls (tabs). */
  header,
  children,
  footer,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  header?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the panel itself rather than the first control, so a screen reader
    // reads the dialog title before anything else.
    const raf = requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      returnFocusTo.current?.focus?.();
    };
  }, [open, onKeyDown]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`panel w-full ${maxWidth} max-h-[88vh] sm:max-h-[80vh] flex flex-col rounded-b-none sm:rounded-2xl outline-none pb-[env(safe-area-inset-bottom)]`}
          >
            <div className="flex items-center justify-between gap-3 p-5 border-b border-holder-700/60">
              {header ?? (
                <h2 id={titleId} className="text-lg font-display font-bold">
                  {title}
                </h2>
              )}
              {header && (
                <span id={titleId} className="sr-only">
                  {title}
                </span>
              )}
              <button
                onClick={onClose}
                aria-label="Close dialog"
                className="shrink-0 w-10 h-10 rounded-lg text-ink-300 hover:text-white hover:bg-holder-800 transition text-xl leading-none"
              >
                ✕
              </button>
            </div>

            <div className="overflow-y-auto p-5 flex-1">{children}</div>

            {footer && (
              <div className="p-5 border-t border-holder-700/60">{footer}</div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
