// The HODLGAME wordmark — "The Held Diamond" system. Every glyph is a
// hand-drawn path on a 100×100 monospace grid (stroke 18 = letter gap 18,
// word gap 36), so no font can reproduce it. Signature, ruler-checkable
// devices that make imitations instantly detectable:
//   * the O is a chamfered square coin holding a solid diamond that rests LOW
//     (bottom tip exactly half a stroke above the counter floor — never
//     centered);
//   * every diagonal is slope 1:2, 2:1 or 4:1 (powers of two only — no 45°);
//   * every free terminal is cut by an 18×9 shear that RISES left-to-right;
//   * the A is apexless with an open sky channel exactly one stroke wide.
// Keep fill-rule="evenodd" — the counters and the held diamond depend on it.
// Do not re-track, round, outline, rotate, or substitute a font for any letter.

const WORD_PATHS = [
  "M0,0 H18 V41 H82 V0 H100 V100 H82 V59 H18 V100 H0 Z", // H
  "M118,0 H190 L218,14 V100 H118 Z M136,18 V82 H200 V18 Z M168,41 L184,57 L168,73 L152,57 Z", // O — the held-diamond coin
  "M236,0 H300 L336,18 V82 L300,100 H236 Z M254,18 V82 H294 L318,70 V30 L294,18 Z", // D
  "M354,0 H372 V82 H454 L445,100 H354 Z", // L
  "M490,0 H590 V23 L572,32 V18 H508 V82 H572 V68 H540 L549,50 H590 V100 H490 Z", // G
  "M608,100 L631,8 H649 L635,64 H681 L667,8 H685 L708,100 H690 L685,80 H631 L626,100 Z", // A — apexless
  "M726,0 H762 L776,28 L790,0 H826 V100 H808 V0 L776,64 L744,0 V100 H726 Z", // M
  "M844,0 H944 L935,18 H862 V41 H944 L935,59 H862 V82 H944 L935,100 H844 Z", // E — rising cuts
];

/** Full wordmark. Scale via `height` (min ~16px; below that use LogoMark). */
export function LogoWord({ height = 18, className = "" }: { height?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 944 100"
      height={height}
      width={height * 9.44}
      className={className}
      role="img"
      aria-label="HODLGAME"
    >
      <g fill="currentColor" fillRule="evenodd">
        {WORD_PATHS.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Square monogram — the coin-O alone. Favicon / app icon / tiny contexts. */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} role="img" aria-label="HODLGAME mark">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M0,0 H72 L100,14 V100 H0 Z M18,18 V82 H82 V18 Z M50,41 L66,57 L50,73 L34,57 Z"
      />
    </svg>
  );
}
