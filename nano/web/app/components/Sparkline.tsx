// Tiny SVG sparkline for the feed cards (not charting — lightweight).
export function Sparkline({
  points,
  width = 96,
  height = 36,
  color = "#ffffff",
}: {
  points: { priceRaw: string }[] | string[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!points || points.length < 2) {
    return <svg width={width} height={height} />;
  }
  const vals = points.map((p) => BigInt(typeof p === "string" ? p : p.priceRaw));
  let min = vals[0];
  let max = vals[0];
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1n;
  const pad = 3;
  const step = (width - 2 * pad) / (vals.length - 1);
  const coords = vals
    .map((v, i) => {
      const x = pad + i * step;
      const y = (height - 2 * pad) - Number((v - min) * BigInt(height - 2 * pad) / span);
      return `${x.toFixed(1)},${(y + pad).toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}