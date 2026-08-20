"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface Point {
  time: number;
  price: number;
}

/**
 * Per-token price chart using TradingView's open-source Lightweight Charts —
 * the same engine DEX aggregators use. Data is reconstructed on-chain from the
 * token's swap events, so it works without any external price feed.
 */
export function PriceChart({
  mint,
  symbol,
  refreshTick,
}: {
  mint: PublicKey;
  symbol: string;
  refreshTick: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [points, setPoints] = useState<Point[] | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth || 600,
      height: 260,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#737373",
        fontFamily: "inherit",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const series = chart.addAreaSeries({
      lineColor: "#00d95f",
      topColor: "rgba(0,217,95,0.22)",
      bottomColor: "rgba(0,217,95,0)",
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth || 600 });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/${mint.toBase58()}/history`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && Array.isArray(d.points)) setPoints(d.points);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mint, refreshTick]);

  useEffect(() => {
    if (!points || !seriesRef.current) return;
    seriesRef.current.setData(
      points.map((p) => ({ time: p.time as UTCTimestamp, value: p.price }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div id="chart" className="panel p-5 sm:p-6 space-y-4 scroll-mt-24">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-ink-100">
          {symbol} chart
        </p>
        <span className="text-[11px] text-ink-500">price (SOL)</span>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 260 }} />
      {points !== null && points.length === 0 && (
        <p className="text-xs text-ink-400 text-center">
          No trades yet — the chart fills in as people buy and sell.
        </p>
      )}
    </div>
  );
}
