"use client";

// Halftone Genome — a deterministic black-and-white halftone "portrait" derived
// purely from a coin's tokenId (+ optional live metric). Every coin gets a
// unique, recomputable monochrome identity. Used ONLY as the fallback when a
// coin has no uploaded image — it never replaces a real token image.
//
// Pure function of public data: anyone can recompute the exact same pattern
// from the tokenId, so it stays honest and verifiable, and it's strictly B&W.

import { useEffect, useRef } from "react";

// Cheap deterministic hash → 32-bit seed (FNV-1a over the hex tokenId).
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// Mulberry32 PRNG — deterministic, seeded.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function HalftoneGenome({ tokenId, size = 96, metric = 0.5, className = "" }: {
  tokenId: string; size?: number; metric?: number; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    cv.width = size * dpr; cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, size, size);

    const r = rng(seedOf(tokenId));
    // Two hash-derived wave centers give each coin a distinct interference field.
    const cx1 = r() * size, cy1 = r() * size, f1 = 0.06 + r() * 0.14;
    const cx2 = r() * size, cy2 = r() * size, f2 = 0.05 + r() * 0.13;
    const rot = r() * Math.PI;
    // Density lifts with the live metric (0..1): a livelier coin reads denser.
    const bias = 0.34 + Math.max(0, Math.min(1, metric)) * 0.28;
    const cell = Math.max(3, Math.round(size / 20));
    ctx.fillStyle = "#ffffff";
    for (let y = cell / 2; y < size; y += cell) {
      for (let x = cell / 2; x < size; x += cell) {
        const d1 = Math.hypot(x - cx1, y - cy1) * f1;
        const d2 = Math.hypot(x - cx2, y - cy2) * f2;
        const v = (Math.sin(d1 + rot) + Math.cos(d2 - rot) + 2) / 4; // 0..1
        const rad = (v * bias) * (cell / 2);
        if (rad > 0.4) {
          ctx.beginPath();
          ctx.arc(x, y, Math.min(cell / 2, rad), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, [tokenId, size, metric]);
  return <canvas ref={ref} style={{ width: size, height: size }} className={className} aria-hidden />;
}
