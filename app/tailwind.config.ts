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
        holder: {
          900: "#0f172a",
          800: "#1e293b",
          700: "#334155",
          accent: "#22d3ee",
          danger: "#f43f5e",
          success: "#34d399",
          jackpot: "#fbbf24",
        },
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
      },
      animation: {
        "spin-slow": "spin-slow 12s linear infinite",
        "pulse-glow": "pulse-glow 2.5s ease-in-out infinite",
        shake: "shake 0.4s ease-in-out",
        "slide-in": "slide-in 0.3s ease-out",
        flash: "flash 0.6s ease-out",
        "flash-accent": "flash-accent 1s ease-out",
        "float-up": "float-up linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
