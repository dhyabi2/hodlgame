"use client";

import { useEffect, useRef, useState } from "react";
import {
  getVolume,
  isAmbientOn,
  isMuted,
  playClick,
  setAmbientPref,
  setMuted,
  setVolume,
  startAmbient,
  stopAmbient,
} from "@/lib/sound";

export function SoundToggle() {
  const [muted, setMutedState] = useState(true);
  const [volume, setVolumeState] = useState(0.7);
  const [ambient, setAmbientState] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMutedState(isMuted());
    setVolumeState(getVolume());
    setAmbientState(isAmbientOn());
    setMounted(true);
    // Note: even if the ambient pref is on, the bed can only start after a
    // user gesture (browser autoplay policy) — the toggle handlers below and
    // any SFX-triggering action resume the context.
    if (isAmbientOn() && !isMuted()) startAmbient();
    return () => stopAmbient();
  }, []);

  // Close the volume popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (next) {
      stopAmbient();
    } else {
      playClick();
      if (ambient) startAmbient();
    }
  };

  const onVolume = (v: number) => {
    setVolume(v);
    setVolumeState(v);
    if (!muted) playClick();
  };

  const toggleAmbient = () => {
    const next = !ambient;
    setAmbientPref(next);
    setAmbientState(next);
    if (next && !muted) {
      startAmbient();
    } else {
      stopAmbient();
    }
  };

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <button
        onClick={toggle}
        aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
        title={muted ? "Unmute" : "Mute"}
        className="rounded-l-lg border border-holder-700 bg-holder-800/60 w-10 h-10 flex items-center justify-center text-lg hover:border-holder-accent transition"
      >
        {mounted ? (muted ? "🔇" : "🔊") : "🔊"}
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Sound settings"
        title="Sound settings"
        className="rounded-r-lg border border-l-0 border-holder-700 bg-holder-800/60 w-6 h-10 flex items-center justify-center text-[10px] text-slate-400 hover:border-holder-accent hover:text-holder-accent transition"
      >
        ▾
      </button>

      {open && (
        <div className="absolute top-12 right-0 z-40 w-56 rounded-xl border border-holder-700 bg-holder-800 p-4 shadow-xl space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wider text-slate-400">
              Volume
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
              className="w-full mt-2 accent-holder-accent"
            />
            <p className="text-xs text-slate-500 mt-1">
              {muted ? "Muted" : `${Math.round(volume * 100)}%`}
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-holder-700 pt-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-400">
                Vault hum
              </p>
              <p className="text-[10px] text-slate-600 mt-0.5">
                Low ambient tone while you watch
              </p>
            </div>
            <button
              onClick={toggleAmbient}
              role="switch"
              aria-checked={ambient}
              aria-label="Toggle ambient sound"
              className={`w-10 h-6 rounded-full transition relative ${
                ambient ? "bg-holder-accent" : "bg-holder-700"
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                  ambient ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
