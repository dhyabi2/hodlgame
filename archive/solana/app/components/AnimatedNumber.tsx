"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";

function formatWithCommas(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function AnimatedNumber({
  value,
  decimals = 2,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const prevValue = useRef(value);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion || !Number.isFinite(value)) {
      setDisplay(value);
      prevValue.current = value;
      return;
    }
    const from = prevValue.current;
    // A poll that returns the same number shouldn't restart an 0.8s tween.
    if (from === value) {
      setDisplay(value);
      return;
    }
    const controls = animate(from, value, {
      duration: 0.8,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(v),
    });
    prevValue.current = value;
    return () => controls.stop();
  }, [value, reduceMotion]);

  return (
    <span className={className} suppressHydrationWarning>
      {Number.isFinite(display) ? formatWithCommas(display, decimals) : "—"}
    </span>
  );
}
