"use client";

import { useEffect, useRef } from "react";
import { createChart, ColorType } from "lightweight-charts";

// TradingView lightweight-charts price area. `series` is price history
// (time in epoch seconds, priceRaw in nano raw-XNO — scaled to XNO here).
export default function PriceChart({ series }: { series: { time: number; priceRaw: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 320,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: false },
      crosshair: { mode: 0 },
    });

    const area = chart.addAreaSeries({
      lineColor: "#22c55e",
      topColor: "rgba(34,197,94,0.35)",
      bottomColor: "rgba(34,197,94,0)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 9, minMove: 1e-12 },
    });

    const data = series.map((p) => ({
      time: p.time as any,
      value: Number(BigInt(p.priceRaw)) / 1e30,
    }));
    area.setData(data.filter((d) => typeof d.time === "number" && Number.isFinite(d.value)));
    chart.timeScale().fitContent();

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [series]);

  return <div ref={ref} style={{ height: 320, width: "100%" }} />;
}