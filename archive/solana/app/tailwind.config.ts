import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)"],
      },
      colors: {
        // pump.fun-inspired: near-black surfaces with one loud green accent.
        // Same token keys as before, so the whole app retunes from this block.
        holder: {
          950: "#050505",
          900: "#0a0a0a",
          800: "#131315",
          700: "#232327",
          accent: "#00d95f",
          accentBright: "#2ee57a",
          danger: "#ff3b5c",
          dangerBright: "#ff6b85",
          success: "#00d95f",
          jackpot: "#f5c542",
          jackpotBright: "#ffd97a",
          // Tier/system hues, kept for the tier aura and info accents.
          violet: "#8b7bf7",
          fun: "#f472b6",
          funBright: "#f9a8d4",
        },
        // Neutral grays — pump.fun reads as black + white, not a tinted slate.
        ink: {
          100: "#f5f5f5",
          200: "#d4d4d4",
          300: "#a3a3a3",
          400: "#737373",
          500: "#525252",
        },
      },
      boxShadow: {
        "glow-accent": "0 0 24px -6px rgba(0, 217, 95, 0.55)",
        "glow-gold": "0 0 24px -6px rgba(245, 197, 66, 0.55)",
        panel:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 40px -20px rgba(0,0,0,0.9)",
      },
      keyframes: {
        "spin-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "pulse-glow": {
          "0%, 100%": { opacity: "0.6", filter: "brightness(1)" },
          "50%": { opacity: "1", filter: "brightness(1.3)" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "20%": { transform: "translateX(-6px)" },
          "40%": { transform: "translateX(6px)" },
          "60%": { transform: "translateX(-4px)" },
          "80%": { transform: "translateX(4px)" },
        },
        "slide-in": {
          "0%": { transform: "translateY(-8px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        flash: {
          "0%": { backgroundColor: "rgba(255, 59, 92, 0.35)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-accent": {
          "0%": { backgroundColor: "rgba(0, 217, 95, 0.25)" },
          "100%": { backgroundColor: "transparent" },
        },
        "float-up": {
          "0%": { transform: "translateY(0)", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { transform: "translateY(-110vh)", opacity: "0" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        "spin-slow": "spin-slow 12s linear infinite",
        "pulse-glow": "pulse-glow 2.5s ease-in-out infinite",
        shake: "shake 0.4s ease-in-out",
        "slide-in": "slide-in 0.3s ease-out",
        flash: "flash 0.6s ease-out",
        "flash-accent": "flash-accent 1s ease-out",
        "float-up": "float-up linear infinite",
        shimmer: "shimmer 6s linear infinite",
        marquee: "marquee 30s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
