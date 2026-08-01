"use client";

import { useEffect, useRef, useState } from "react";
import {
  getVolume,
  isMuted,
  playClick,
  setMuted,
  setVolume,
} from "@/lib/sound";

export function SoundToggle() {
  const [muted, setMutedState] = useState(true);
  const [volume, setVolumeState] = useState(0.7);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMutedState(isMuted());
    setVolumeState(getVolume());
    setMounted(true);
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
    if (!next) playClick();
  };

  const onVolume = (v: number) => {
    setVolume(v);
    setVolumeState(v);
    if (!muted) playClick();
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
        title="Volume"
        className="rounded-r-lg border border-l-0 border-holder-700 bg-holder-800/60 w-6 h-10 flex items-center justify-center text-[10px] text-slate-400 hover:border-holder-accent hover:text-holder-accent transition"
      >
        ▾
      </button>

      {open && (
        <div className="absolute top-12 right-0 z-40 w-52 rounded-xl border border-holder-700 bg-holder-800 p-4 shadow-xl">
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
      )}
    </div>
  );
}
