"use client";

// PWA install prompt. On Chrome/Android/desktop it captures the
// `beforeinstallprompt` event and shows a stark-monochrome bar inviting the
// user to install; on iOS Safari (which has no such event) it shows the
// Share → "Add to Home Screen" hint. Dismissal is remembered per browser, and
// it never shows once the app is already running as an installed PWA.

import { useEffect, useState } from "react";

const DISMISS_KEY = "hodlgame-install-dismissed";

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<any>(null);
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    // Already installed / running standalone → never prompt.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true;
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === "1"; } catch {}
    if (standalone || dismissed) return;

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

    const onPrompt = (e: Event) => {
      e.preventDefault(); // stash it; we present our own UI
      setDeferred(e);
      // Delay a touch so it doesn't fight the first paint / welcome gate.
      setTimeout(() => setShow(true), 4000);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    // iOS never fires beforeinstallprompt — show the manual "Add to Home Screen".
    if (isIos && isSafari) setTimeout(() => { setIos(true); setShow(true); }, 6000);

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  };

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch {}
    setDeferred(null);
    dismiss();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[70] flex justify-center px-3 pb-3 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-none border border-neutral-700 bg-neutral-950 p-4 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="shrink-0 bg-black p-1">
            {/* the coin-O mark */}
            <svg viewBox="0 0 100 100" width="34" height="34" aria-hidden>
              <path fill="#fff" fillRule="evenodd" d="M0,0 H72 L100,14 V100 H0 Z M18,18 V82 H82 V18 Z M50,41 L66,57 L50,73 L34,57 Z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-white">Install HodlGame</p>
            {ios ? (
              <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
                Tap the <span className="text-white">Share</span> button, then{" "}
                <span className="text-white">“Add to Home Screen”</span> to install the app.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-neutral-400 leading-relaxed">
                Add it to your home screen for instant, full-screen access — plays like a native app.
              </p>
            )}
          </div>
          <button onClick={dismiss} className="shrink-0 text-neutral-500 hover:text-white text-lg leading-none" aria-label="dismiss">×</button>
        </div>
        {!ios && (
          <div className="mt-3 flex gap-2">
            <button onClick={install} className="flex-1 rounded-none bg-white py-2 text-xs font-black uppercase tracking-wide text-black hover:bg-neutral-200">
              Install
            </button>
            <button onClick={dismiss} className="rounded-none border border-neutral-800 px-4 py-2 text-xs font-bold text-neutral-400 hover:border-white hover:text-white">
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
