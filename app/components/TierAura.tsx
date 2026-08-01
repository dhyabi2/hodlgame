"use client";

import { BN } from "@coral-xyz/anchor";
import { getHoldingScore } from "@/lib/tiers";

/**
 * A fixed, very soft radial wash tinted by the connected user's tier — the
 * whole page quietly acknowledges *your* status. Paper hands get a faint
 * grey; Diamond hands see the room glow cyan. Purely decorative (aria-hidden),
 * cheap (one div, no animation), and absent when no position exists.
 */
export function TierAura({
  position,
}: {
  position: { amount: BN; points: BN } | null;
}) {
  if (!position || !position.amount.gtn(0)) return null;
  const { tier } = getHoldingScore(position.points, position.amount);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 transition-[background] duration-1000"
      style={{
        background: `radial-gradient(1200px 600px at 50% -10%, ${tier.hex}14, transparent 70%)`,
      }}
    />
  );
}
