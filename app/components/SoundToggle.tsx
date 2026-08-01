"use client";

import { useEffect, useState } from "react";
import { isMuted, setMuted, playClick } from "@/lib/sound";

export function SoundToggle() {
  const [muted, setMutedState] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMutedState(isMuted());
    setMounted(true);
  }, []);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playClick();
  };

  return (
    <button
      onClick={toggle}
      aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
      title={muted ? "Unmute" : "Mute"}
      className="rounded-lg border border-holder-700 bg-holder-800/60 w-10 h-10 flex items-center justify-center text-lg hover:border-holder-accent transition"
    >
      {mounted ? (muted ? "🔇" : "🔊") : "🔊"}
    </button>
  );
}
