"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

const SEEN_KEY = "holder:seenSplash";

const SHARDS = Array.from({ length: 10 }, (_, i) => ({
  angle: (360 / 10) * i,
  delay: i * 0.03,
}));

export function SplashIntro() {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setMounted(true);
    const seen = window.localStorage.getItem(SEEN_KEY);
    if (!seen) setVisible(true);
  }, []);

  const dismiss = () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setVisible(false);
  };

  if (!mounted || !visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-holder-900"
        initial={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4 }}
      >
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 text-slate-500 hover:text-white text-sm"
        >
          Skip ✕
        </button>

        <div className="relative flex flex-col items-center gap-6 px-6 text-center">
          <div className="relative w-40 h-40">
            {!reduceMotion &&
              SHARDS.map((shard, i) => (
                <motion.div
                  key={i}
                  className="absolute left-1/2 top-1/2 w-6 h-8 bg-slate-300/80 rounded-sm"
                  style={{ marginLeft: -12, marginTop: -16 }}
                  initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
                  animate={{
                    x: Math.cos((shard.angle * Math.PI) / 180) * 140,
                    y: Math.sin((shard.angle * Math.PI) / 180) * 140,
                    opacity: 0,
                    rotate: 180,
                    scale: 0.4,
                  }}
                  transition={{
                    duration: 1.1,
                    delay: shard.delay,
                    ease: "easeOut",
                  }}
                />
              ))}

            <motion.svg
              viewBox="0 0 100 100"
              className="relative w-full h-full glow-accent"
              initial={reduceMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.3 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: reduceMotion ? 0 : 0.5, ease: "backOut" }}
            >
              <polygon points="50,5 90,35 50,95 10,35" fill="url(#splashDiamondBody)" />
              <polygon points="50,5 90,35 50,45" fill="#67e8f9" opacity="0.85" />
              <polygon points="50,5 10,35 50,45" fill="#22d3ee" opacity="0.7" />
              <polygon points="10,35 50,45 50,95" fill="#0e7490" opacity="0.8" />
              <polygon points="90,35 50,45 50,95" fill="#155e75" opacity="0.8" />
              <defs>
                <linearGradient id="splashDiamondBody" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#a5f3fc" />
                  <stop offset="50%" stopColor="#22d3ee" />
                  <stop offset="100%" stopColor="#0891b2" />
                </linearGradient>
              </defs>
            </motion.svg>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 1.2, duration: 0.5 }}
            className="space-y-2"
          >
            <h1 className="font-display text-4xl md:text-5xl font-bold metallic-text">
              HOLDER
            </h1>
            <p className="text-slate-400 max-w-xs mx-auto">
              Paper hands pay the tax. Diamond hands collect it.
            </p>
          </motion.div>

          <motion.button
            onClick={dismiss}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0.2 : 1.6, duration: 0.5 }}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            className="px-8 py-3 rounded-xl font-bold bg-holder-accent text-holder-900 hover:bg-cyan-300 transition"
          >
            Enter the Vault
          </motion.button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
