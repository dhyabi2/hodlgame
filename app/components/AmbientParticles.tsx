"use client";

import { useReducedMotion } from "framer-motion";

const PARTICLES = Array.from({ length: 16 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  size: 2 + ((i * 7) % 4),
  duration: 14 + ((i * 5) % 12),
  delay: -(i * 1.7),
  opacity: 0.15 + ((i * 3) % 4) * 0.05,
}));

/**
 * Pure CSS floating-particle background — no canvas/library. Purely
 * decorative, so it's aria-hidden and skipped entirely for
 * prefers-reduced-motion instead of just freezing in place.
 */
export function AmbientParticles() {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden z-0"
    >
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-holder-accent animate-float-up"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            opacity: p.opacity,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
            bottom: "-5%",
          }}
        />
      ))}
    </div>
  );
}
