/**
 * Deterministic token avatar, generated client-side from the token's name and
 * symbol. Same inputs always produce the same image, so every launch gets a
 * distinct visual identity without needing an external image service — the
 * pump.fun "generated token" look, self-hosted.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function hueToRgb(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (n: number) => Math.round(255 * f(n));
  return `rgb(${to(0)}, ${to(8)}, ${to(4)})`;
}

const SHAPES = ["circle", "diamond", "hex", "ring", "burst"] as const;

export function tokenAvatarSvg(name: string, symbol: string): string {
  const seed = hash(`${name}\u0000${symbol}`);
  const h1 = seed % 360;
  const h2 = (h1 + 45 + (seed % 90)) % 360;
  const shape = SHAPES[seed % SHAPES.length];
  const label = (symbol || name || "?").trim().slice(0, 3).toUpperCase() || "?";

  const c1 = hueToRgb(h1, 68, 58);
  const c2 = hueToRgb(h2, 72, 46);

  let emblem = "";
  if (shape === "circle") {
    emblem = `<circle cx="50" cy="50" r="26" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.5)" stroke-width="3"/>`;
  } else if (shape === "diamond") {
    emblem = `<polygon points="50,20 80,50 50,80 20,50" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.5)" stroke-width="3"/>`;
  } else if (shape === "hex") {
    emblem = `<polygon points="50,22 74,36 74,64 50,78 26,64 26,36" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.5)" stroke-width="3"/>`;
  } else if (shape === "ring") {
    emblem = `<circle cx="50" cy="50" r="26" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="7"/><circle cx="50" cy="50" r="12" fill="rgba(255,255,255,0.3)"/>`;
  } else {
    emblem = `<polygon points="50,20 55,45 80,50 55,55 50,80 45,55 20,50 45,45" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.5)" stroke-width="2.5"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.25" r="0.9">
      <stop offset="0%" stop-color="rgba(255,255,255,0.55)"/>
      <stop offset="40%" stop-color="rgba(255,255,255,0.12)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.25)"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <rect width="100" height="100" rx="22" fill="url(#glow)"/>
  ${emblem}
  <text x="50" y="56" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${label.length > 2 ? 18 : 22}" font-weight="800" fill="#ffffff" letter-spacing="0.5">${label}</text>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
