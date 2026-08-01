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
        // Retuned away from stock Tailwind slate to a custom obsidian scale
        // with a violet-blue cast. Same token keys, so the whole app upgrades
        // from this one block.
        holder: {
          950: "#06070e",
          900: "#0b0d19",
          800: "#151829",
          700: "#2a2f4e",
          accent: "#22d3ee",
          danger: "#f43f5e",
          success: "#34d399",
          jackpot: "#f6c34a",
        },
      },
      boxShadow: {
        "glow-accent": "0 0 24px -6px rgba(34, 211, 238, 0.55)",
        "glow-gold": "0 0 24px -6px rgba(246, 195, 74, 0.55)",
        panel:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 40px -20px rgba(0,0,0,0.8)",
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
          "0%": { backgroundColor: "rgba(244, 63, 94, 0.35)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-accent": {
          "0%": { backgroundColor: "rgba(34, 211, 238, 0.25)" },
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
      },
    },
  },
  plugins: [],
};
export default config;
